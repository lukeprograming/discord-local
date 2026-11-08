/**
 * Tratamento do microfone antes de enviar: supressão de ruído, volume (ganho)
 * e sensibilidade (noise gate — abaixo do limite os outros recebem silêncio).
 *
 *   mic → [nivelador: compressor + ganho] → supressão por IA (opcional) → ganho → gate → stream enviada
 *
 * O nivelador (opcional) sobe a voz baixa de quem fala longe do microfone ANTES da IA,
 * senão a IA confunde voz fraca com ruído e corta.
 *
 * A stream de saída é sempre a mesma: trocar a supressão no meio da call não
 * precisa renegociar nada com os outros.
 */
import type { AiMode, AiNode } from './noise-ai.ts';

/** Limite padrão usado para "falando" quando a sensibilidade está no automático. */
export const AUTO_SPEAKING_DB = -34;

/**
 * off: nada. native: filtro embutido do Chromium/WebRTC (leve, fraco).
 * rnnoise: IA leve, clássica. gtcrn: IA mais nova, limpa mais e preserva melhor a voz.
 */
export type NoiseMode = 'off' | 'native' | AiMode;
/** GTCRN venceu o RNNoise em todos os testes (voz + chiado/ventilador): +6 a +9 dB de limpeza com a mesma voz. */
export const DEFAULT_NOISE: NoiseMode = 'gtcrn';
/** Toda captura de microfone usa esta taxa, exigida pelos modelos de IA. */
export const MIC_SAMPLE_RATE = 48000;

const workletUrl = new URL('./gate-worklet.js', import.meta.url).href;
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

function loadWorklet(ctx: AudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(workletUrl);
    loaded.set(ctx, p);
  }
  return p;
}

export type MicSettings = { volume: number; threshold: number | null; noise: NoiseMode; level: boolean };

/** Constraints do getUserMedia. A supressão nativa só fica ligada no modo "native": somada à IA ela come a voz. */
export function micConstraints(micId: string | undefined, noise: NoiseMode): MediaTrackConstraints {
  return {
    deviceId: micId ? { ideal: micId } : undefined,
    echoCancellation: true,
    noiseSuppression: noise === 'native',
    autoGainControl: true,
    channelCount: 1,
    sampleRate: MIC_SAMPLE_RATE,
  };
}

export class MicProcessor {
  /** Stream que vai para os outros (já com supressão, ganho e gate). */
  readonly output: MediaStream;
  /** Nível atual (dB, antes do gate) e se o gate está aberto. */
  db = -100;
  open = true;
  onLevel: (db: number, open: boolean) => void = () => {};
  /** Modo de supressão realmente em uso (cai para "native" se a IA não carregar). */
  activeNoise: NoiseMode = 'off';
  onNoiseChange: (active: NoiseMode, error: string | null) => void = () => {};

  private ctx: AudioContext;
  private track: MediaStreamTrack | undefined;
  private src: MediaStreamAudioSourceNode;
  private ai: AiNode | null = null;
  private gain: GainNode;
  private comp: DynamicsCompressorNode;
  private makeup: GainNode;
  private levelOn: boolean;
  private gate: AudioWorkletNode | null;
  private last: AudioNode;
  private threshold: number | null;
  private wantedNoise: NoiseMode | null = null;
  private noiseJob: Promise<void> = Promise.resolve();
  private monitoring = false;
  private destroyed = false;

  private constructor(ctx: AudioContext, input: MediaStream, gate: AudioWorkletNode | null, s: MicSettings) {
    this.ctx = ctx;
    this.track = input.getAudioTracks()[0];
    this.src = ctx.createMediaStreamSource(input);
    this.gain = ctx.createGain();
    this.gain.gain.value = s.volume;
    this.threshold = s.threshold;
    // Nivelador: comprime forte e devolve +10 dB — voz baixa sobe, grito não estoura.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -45;
    this.comp.knee.value = 20;
    this.comp.ratio.value = 8;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.3;
    this.makeup = ctx.createGain();
    this.makeup.gain.value = 3.2;
    this.comp.connect(this.makeup);
    this.levelOn = s.level;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    this.wire();
    this.gate = gate;
    if (gate) {
      this.gain.connect(gate).connect(dest);
      gate.port.onmessage = (e: MessageEvent<{ db: number; open: boolean }>) => {
        this.db = e.data.db;
        this.open = e.data.open;
        this.onLevel(this.db, this.open);
      };
      gate.port.postMessage({ threshold: s.threshold });
    } else {
      this.gain.connect(dest);
    }
    this.last = gate ?? this.gain;
    this.output = dest.stream;
  }

  /** Sem AudioWorklet (navegador muito antigo) ainda devolve o ganho, só sem gate nem IA. */
  static async create(ctx: AudioContext, input: MediaStream, s: MicSettings): Promise<MicProcessor> {
    let gate: AudioWorkletNode | null = null;
    try {
      await loadWorklet(ctx);
      gate = new AudioWorkletNode(ctx, 'noise-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    } catch (e) {
      console.warn('[mic] sem noise gate', e);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const proc = new MicProcessor(ctx, input, gate, s);
    proc.setNoise(s.noise);
    return proc;
  }

  /** Liga as peças na ordem: mic → (nivelador) → (IA) → ganho. */
  private wire(): void {
    this.src.disconnect();
    this.makeup.disconnect();
    this.ai?.disconnect();
    if (this.levelOn) this.src.connect(this.comp);
    const head: AudioNode = this.levelOn ? this.makeup : this.src;
    if (this.ai) head.connect(this.ai).connect(this.gain);
    else head.connect(this.gain);
  }

  set(s: MicSettings): void {
    this.gain.gain.value = s.volume;
    if (s.level !== this.levelOn) {
      this.levelOn = s.level;
      this.wire();
    }
    this.threshold = s.threshold;
    this.gate?.port.postMessage({ threshold: s.threshold });
    this.setNoise(s.noise);
  }

  /** Troca a supressão de ruído. As trocas rodam em fila; só a última pedida vale. */
  setNoise(mode: NoiseMode): void {
    if (mode === this.wantedNoise) return;
    this.wantedNoise = mode;
    this.noiseJob = this.noiseJob.then(() => this.applyNoise(mode));
  }

  private async applyNoise(mode: NoiseMode): Promise<void> {
    if (this.destroyed || mode !== this.wantedNoise) return;
    let node: AiNode | null = null;
    let error: string | null = null;
    if (mode === 'rnnoise' || mode === 'gtcrn') {
      try {
        const { createAiNode } = await import('./noise-ai.ts');
        node = await createAiNode(this.ctx, mode);
      } catch (e) {
        console.warn('[mic] supressão por IA indisponível', e);
        error = `Supressão por IA indisponível (${(e as Error).message}); usando a nativa.`;
      }
      // Pediram outra coisa enquanto carregava, ou fechou.
      if (this.destroyed || mode !== this.wantedNoise) {
        node?.destroy();
        return;
      }
    }
    const active: NoiseMode = node ? mode : mode === 'off' ? 'off' : 'native';

    // Liga/desliga o filtro nativo na própria captura, mantendo as outras constraints (aparelho etc.).
    const native = active === 'native';
    if (this.track && this.track.getSettings().noiseSuppression !== native) {
      await this.track.applyConstraints({ ...this.track.getConstraints(), noiseSuppression: native }).catch((e) => {
        console.warn('[mic] applyConstraints', e);
      });
    }

    if (this.ai) {
      this.ai.disconnect();
      this.ai.destroy();
    }
    this.ai = node;
    this.wire();
    this.activeNoise = active;
    this.onNoiseChange(active, error);
  }

  /** Toca o que os outros vão ouvir na minha própria saída (teste nas Configurações). */
  monitor(on: boolean): void {
    if (on === this.monitoring) return;
    this.monitoring = on;
    if (on) this.last.connect(this.ctx.destination);
    else this.last.disconnect(this.ctx.destination);
  }

  destroy(): void {
    this.destroyed = true;
    this.ai?.destroy();
    this.ai = null;
  }

  /** "Falando" para o indicador: gate aberto (manual) ou acima do limite padrão (automático). */
  get speaking(): boolean {
    if (!this.gate) return false;
    return this.threshold === null ? this.db > AUTO_SPEAKING_DB : this.open;
  }

  get hasGate(): boolean {
    return !!this.gate;
  }
}
