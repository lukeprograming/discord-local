/**
 * Tratamento do microfone antes de enviar: volume (ganho) e sensibilidade
 * (noise gate — abaixo do limite os outros recebem silêncio).
 *
 *   mic → ganho → gate (AudioWorklet) → stream enviada
 */

/** Limite padrão usado para "falando" quando a sensibilidade está no automático. */
export const AUTO_SPEAKING_DB = -34;

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

export type MicSettings = { volume: number; threshold: number | null };

export class MicProcessor {
  /** Stream que vai para os outros (já com ganho e gate). */
  readonly output: MediaStream;
  /** Nível atual (dB, antes do gate) e se o gate está aberto. */
  db = -100;
  open = true;
  onLevel: (db: number, open: boolean) => void = () => {};

  private gain: GainNode;
  private gate: AudioWorkletNode | null;
  private threshold: number | null;

  private constructor(ctx: AudioContext, input: MediaStream, gate: AudioWorkletNode | null, s: MicSettings) {
    const src = ctx.createMediaStreamSource(input);
    this.gain = ctx.createGain();
    this.gain.gain.value = s.volume;
    this.threshold = s.threshold;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    src.connect(this.gain);
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
    this.output = dest.stream;
  }

  /** Sem AudioWorklet (navegador muito antigo) ainda devolve o ganho, só sem gate. */
  static async create(ctx: AudioContext, input: MediaStream, s: MicSettings): Promise<MicProcessor> {
    let gate: AudioWorkletNode | null = null;
    try {
      await loadWorklet(ctx);
      gate = new AudioWorkletNode(ctx, 'noise-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    } catch (e) {
      console.warn('[mic] sem noise gate', e);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return new MicProcessor(ctx, input, gate, s);
  }

  set(s: MicSettings): void {
    this.gain.gain.value = s.volume;
    this.threshold = s.threshold;
    this.gate?.port.postMessage({ threshold: s.threshold });
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
