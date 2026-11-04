import type { CallInfo, RtcSignal } from '../../shared/protocol.ts';
import type { GatewayClient } from './gateway.ts';
import { MicProcessor, type MicSettings } from './mic.ts';

export type ScreenPreset = '720p30' | '1080p30' | '1080p60';

export const SCREEN_PRESETS: Record<ScreenPreset, { width: number; height: number; fps: number; bitrate: number; label: string }> = {
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_500_000, label: '720p 30fps' },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 4_000_000, label: '1080p 30fps' },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 6_000_000, label: '1080p 60fps' },
};

const CAMERA = { width: 1280, height: 720, fps: 30, bitrate: 1_500_000 };

/** voice = microfone da pessoa; screen = áudio do PC que vem junto com a transmissão de tela. */
export type AudioKind = 'voice' | 'screen';

export type RemotePeer = {
  connectionId: string;
  userId: string;
  state: RTCPeerConnectionState;
  screen: MediaStream | null;
  camera: MediaStream | null;
  speaking: boolean;
};

export type CallOptions = {
  micId?: string;
  speakerId?: string;
  mic: MicSettings;
  /** webaudio: volume até 200% e saída escolhida pelo AudioContext (desktop). element: <audio> até 100% (Android, que roteia fone/alto-falante por fora). */
  playback: 'webaudio' | 'element';
  /** Volume (1 = 100%) que eu escolhi para essa pessoa. */
  volumeOf: (userId: string, kind: AudioKind) => number;
};

type RemoteAudio = {
  stream: MediaStream;
  el: HTMLAudioElement;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
};

type Peer = {
  pc: RTCPeerConnection;
  userId: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  audios: Map<string, RemoteAudio>; // stream.id -> áudio
  videos: Map<string, MediaStream>; // stream.id -> tela ou câmera
  /** stream.id da câmera do outro lado (avisado por sinal 'streams'); o resto é tela. */
  cameraId: string | null;
  screenSenders: RTCRtpSender[];
  cameraSenders: RTCRtpSender[];
  speaking: boolean;
  queue: Promise<void>; // sinais processados em ordem, um de cada vez
  watchdog: number;
  restarts: number;
};

const SPEAKING_THRESHOLD = 0.02;
const ICE_WATCHDOG_MS = 8000;
const MAX_ICE_RESTARTS = 3;

// Histórico da negociação, para depurar pelo DevTools: window.__rtclog
const rtcLog: string[] = ((window as unknown as { __rtclog: string[] }).__rtclog = []);
function log(...parts: unknown[]): void {
  rtcLog.push(`${(performance.now() / 1000).toFixed(2)} ${parts.join(' ')}`);
  if (rtcLog.length > 500) rtcLog.shift();
}

/**
 * Uma call em mesh: um RTCPeerConnection por participante.
 * Renegociação via "perfect negotiation" — qualquer lado pode adicionar/remover
 * a tela a qualquer momento sem colisão de offers.
 */
export class CallSession {
  readonly conversationId: string;
  muted = false;
  deafened = false;
  screen: MediaStream | null = null;
  camera: MediaStream | null = null;
  localSpeaking = false;
  /** Entrou sem microfone: só ouve. */
  noMic = false;
  onChange: () => void = () => {};
  /** Transmissão parada pelo botão do sistema (fora do app). */
  onScreenEnded: () => void = () => {};

  private ready = false;
  private gw: GatewayClient;
  private myConnectionId: string;
  private mic: MediaStream | null = null;
  /** O que realmente vai para os outros (mic com volume e gate). */
  private send: MediaStream | null = null;
  private micProc: MicProcessor | null = null;
  private peers = new Map<string, Peer>();
  private opts!: CallOptions;
  private audioCtx = new AudioContext();
  private localAnalyser: AnalyserNode | null = null;
  private vadTimer = 0;
  private closed = false;

  constructor(gw: GatewayClient, conversationId: string, myConnectionId: string) {
    this.gw = gw;
    this.conversationId = conversationId;
    this.myConnectionId = myConnectionId;
  }

  /** Sem microfone a call continua funcionando só para ouvir (e ver/transmitir tela). Devolve o erro do microfone, se houve. */
  async start(opts: CallOptions): Promise<Error | null> {
    this.opts = opts;
    if (opts.playback === 'webaudio' && opts.speakerId) {
      const ctx = this.audioCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      await ctx.setSinkId?.(opts.speakerId).catch((e) => console.warn('[rtc] saída', e));
    }
    let micError: Error | null = null;
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: opts.micId ? { ideal: opts.micId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      try {
        this.micProc = await MicProcessor.create(this.audioCtx, this.mic, opts.mic);
        this.send = this.micProc.output;
      } catch (e) {
        console.warn('[rtc] mic sem tratamento', e);
        this.send = this.mic;
      }
      if (!this.micProc?.hasGate) this.localAnalyser = this.analyse(this.mic);
    } catch (e) {
      micError = e as Error;
      this.noMic = true;
      this.muted = true;
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    this.vadTimer = window.setInterval(() => this.detectSpeaking(), 150);
    this.ready = true;
    return micError;
  }

  remotes(): RemotePeer[] {
    return [...this.peers.entries()].map(([connectionId, p]) => ({
      connectionId,
      userId: p.userId,
      state: p.pc.connectionState,
      screen: [...p.videos.values()].find((v) => v.id !== p.cameraId) ?? null,
      camera: (p.cameraId && p.videos.get(p.cameraId)) || null,
      speaking: p.speaking,
    }));
  }

  /** Mudou volume/sensibilidade do meu microfone nas Configurações. */
  setMicSettings(s: MicSettings): void {
    this.opts.mic = s;
    this.micProc?.set(s);
  }

  /** Reaplica os volumes de cada pessoa (mudou algum controle). */
  refreshVolumes(): void {
    for (const p of this.peers.values()) this.applyVolumes(p);
  }

  /** Sincroniza os peers com a lista de participantes vinda do servidor. */
  sync(call: CallInfo): void {
    // Só conecta depois do microfone pronto e de o servidor me listar na call.
    if (this.closed || !this.ready || !call.participants.some((p) => p.connection_id === this.myConnectionId)) return;
    const present = new Set(call.participants.map((p) => p.connection_id));
    for (const p of call.participants) {
      if (p.connection_id !== this.myConnectionId && !this.peers.has(p.connection_id)) {
        this.createPeer(p.connection_id, p.user_id);
      }
    }
    for (const connId of [...this.peers.keys()]) if (!present.has(connId)) this.closePeer(connId);
    this.onChange();
  }

  handleSignal(fromConnectionId: string, fromUserId: string, signal: RtcSignal): void {
    if (this.closed) return;
    const peer = this.peers.get(fromConnectionId) ?? this.createPeer(fromConnectionId, fromUserId);
    // Em fila: um candidate não pode ser aplicado antes da offer que chegou antes dele.
    peer.queue = peer.queue.then(() => this.applySignal(peer, fromConnectionId, signal));
  }

  private async applySignal(peer: Peer, fromConnectionId: string, signal: RtcSignal): Promise<void> {
    if (this.closed || this.peers.get(fromConnectionId) !== peer) return;
    log('recv', signal.type, 'de', fromConnectionId.slice(-4));
    if (signal.type === 'streams') {
      peer.cameraId = signal.camera;
      this.onChange();
      return;
    }
    const pc = peer.pc;
    try {
      if (signal.type === 'candidate') {
        try {
          await pc.addIceCandidate(signal.candidate ?? undefined);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
        return;
      }
      const collision = signal.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      log('desc', signal.type, 'collision=' + collision, 'ignore=' + peer.ignoreOffer, 'state=' + pc.signalingState);
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription({ type: signal.type, sdp: signal.sdp });
      if (signal.type === 'offer') {
        await pc.setLocalDescription();
        this.signal(fromConnectionId, { type: 'answer', sdp: pc.localDescription!.sdp });
      }
    } catch (e) {
      log('erro', signal.type, (e as Error).message);
      console.error('[rtc] sinal', signal.type, e);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted || this.noMic;
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted && !this.deafened;
    this.onChange();
  }

  /** Deafen: não ouve ninguém e também não fala (como no Discord). */
  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    this.refreshVolumes();
    this.setMuted(this.muted);
  }

  async startScreen(preset: ScreenPreset, withAudio: boolean, hint: 'detail' | 'motion'): Promise<void> {
    const cfg = SCREEN_PRESETS[preset];
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: cfg.width }, height: { ideal: cfg.height }, frameRate: { ideal: cfg.fps, max: cfg.fps } },
      audio: withAudio,
    });
    this.stopScreen();
    this.screen = stream;
    const video = stream.getVideoTracks()[0];
    video.contentHint = hint;
    // Usuário clicou em "parar compartilhamento" na barra do sistema.
    video.addEventListener('ended', () => {
      if (this.screen !== stream) return;
      this.stopScreen();
      this.onScreenEnded();
    });
    for (const [, peer] of this.peers) this.attachScreen(peer, cfg.bitrate, cfg.fps);
    this.screenCfg = cfg;
    this.onChange();
  }

  stopScreen(): void {
    if (!this.screen) return;
    for (const t of this.screen.getTracks()) t.stop();
    this.screen = null;
    this.screenCfg = null;
    // Remove as tracks da tela (vídeo e, no Windows, o áudio do sistema) → renegocia.
    for (const peer of this.peers.values()) {
      removeSenders(peer.pc, peer.screenSenders);
      peer.screenSenders = [];
    }
    this.onChange();
  }

  async startCamera(deviceId?: string): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { ideal: deviceId } : undefined,
        facingMode: deviceId ? undefined : 'user',
        width: { ideal: CAMERA.width },
        height: { ideal: CAMERA.height },
        frameRate: { ideal: CAMERA.fps, max: CAMERA.fps },
      },
    });
    if (this.closed) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stopCamera();
    this.camera = stream;
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'motion';
    track.addEventListener('ended', () => {
      if (this.camera === stream) this.stopCamera();
    });
    for (const [connId, peer] of this.peers) {
      // Avisa antes da offer qual stream é a câmera (os sinais chegam em ordem).
      this.signal(connId, { type: 'streams', camera: stream.id });
      this.attachCamera(peer);
    }
    this.onChange();
  }

  stopCamera(): void {
    if (!this.camera) return;
    for (const t of this.camera.getTracks()) t.stop();
    this.camera = null;
    for (const [connId, peer] of this.peers) {
      removeSenders(peer.pc, peer.cameraSenders);
      peer.cameraSenders = [];
      this.signal(connId, { type: 'streams', camera: null });
    }
    this.onChange();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.vadTimer);
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    for (const t of this.screen?.getTracks() ?? []) t.stop();
    for (const t of this.camera?.getTracks() ?? []) t.stop();
    this.audioCtx.close();
  }

  // ---- internos ----

  private screenCfg: { bitrate: number; fps: number } | null = null;

  private createPeer(connectionId: string, userId: string): Peer {
    log('createPeer', connectionId.slice(-4), 'mic=' + !!this.mic);
    // Pela VPN todos os peers têm IP direto: sem STUN/TURN.
    const pc = new RTCPeerConnection({ iceServers: [] });
    const peer: Peer = {
      pc,
      userId,
      polite: this.myConnectionId > connectionId,
      makingOffer: false,
      ignoreOffer: false,
      audios: new Map(),
      videos: new Map(),
      cameraId: null,
      screenSenders: [],
      cameraSenders: [],
      speaking: false,
      queue: Promise.resolve(),
      watchdog: 0,
      restarts: 0,
    };
    this.peers.set(connectionId, peer);
    this.armWatchdog(peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(connectionId, { type: 'offer', sdp: pc.localDescription!.sdp });
      } catch (e) {
        log('erro negociação', (e as Error).message);
        console.error('[rtc] negociação', e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => this.signal(connectionId, { type: 'candidate', candidate: candidate?.toJSON() ?? null });
    pc.onsignalingstatechange = () => log('signaling', pc.signalingState);
    pc.onconnectionstatechange = () => {
      log('conn', pc.connectionState);
      if (pc.connectionState === 'connected') {
        clearTimeout(peer.watchdog);
        peer.restarts = 0;
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.armWatchdog(peer);
      }
      this.onChange();
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      if (track.kind === 'video') {
        peer.videos.set(stream.id, stream);
        stream.onremovetrack = () => {
          if (!stream.getVideoTracks().length) peer.videos.delete(stream.id);
          this.applyVolumes(peer);
          this.onChange();
        };
      } else if (!peer.audios.has(stream.id)) {
        // Um áudio por stream: voz e áudio do sistema da tela têm volumes separados.
        peer.audios.set(stream.id, this.playRemote(stream));
      }
      // A tela (vídeo + áudio do PC) vem numa stream só: o vídeo define que esse áudio é "da tela".
      this.applyVolumes(peer);
      this.onChange();
    };

    for (const t of this.send?.getTracks() ?? []) pc.addTrack(t, this.send!);
    // Sem microfone não há o que enviar e a negociação nem começaria: pede só para receber o áudio.
    if (!this.send) pc.addTransceiver('audio', { direction: 'recvonly' });
    if (this.screen && this.screenCfg) this.attachScreen(peer, this.screenCfg.bitrate, this.screenCfg.fps);
    if (this.camera) {
      this.signal(connectionId, { type: 'streams', camera: this.camera.id });
      this.attachCamera(peer);
    }
    return peer;
  }

  private playRemote(stream: MediaStream): RemoteAudio {
    const el = new Audio();
    el.srcObject = stream;
    let gain: GainNode | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      const src = this.audioCtx.createMediaStreamSource(stream);
      analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      if (this.opts.playback === 'webaudio') {
        // Toca pelo AudioContext (permite passar de 100%). O <audio> mudo continua
        // necessário: sem ele o Chromium não entrega o áudio remoto ao WebAudio.
        gain = this.audioCtx.createGain();
        src.connect(gain).connect(this.audioCtx.destination);
        el.muted = true;
      }
    } catch (e) {
      console.warn('[rtc] webaudio remoto', e);
    }
    if (!gain && this.opts.speakerId) el.setSinkId(this.opts.speakerId).catch(() => {});
    el.play().catch((e) => console.warn('[rtc] play', e));
    return { stream, el, gain, analyser };
  }

  private applyVolumes(peer: Peer): void {
    for (const a of peer.audios.values()) {
      const kind: AudioKind = a.stream.getVideoTracks().length ? 'screen' : 'voice';
      const v = this.deafened ? 0 : Math.max(0, this.opts.volumeOf(peer.userId, kind));
      if (a.gain) a.gain.gain.value = v;
      else {
        a.el.volume = Math.min(1, v);
        a.el.muted = this.deafened;
      }
    }
  }

  private attachCamera(peer: Peer): void {
    const stream = this.camera!;
    for (const track of stream.getVideoTracks()) {
      const tr = peer.pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: [{ maxBitrate: CAMERA.bitrate, maxFramerate: CAMERA.fps }],
      });
      peer.cameraSenders.push(tr.sender);
    }
  }

  private attachScreen(peer: Peer, bitrate: number, fps: number): void {
    const stream = this.screen!;
    for (const track of stream.getTracks()) {
      const tr = peer.pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: track.kind === 'video' ? [{ maxBitrate: bitrate, maxFramerate: fps }] : undefined,
      });
      peer.screenSenders.push(tr.sender);
      if (track.kind === 'video') preferCodec(tr, 'video/VP9');
    }
  }

  /** Se não conectar em alguns segundos, reinicia o ICE (renegocia do zero). */
  private armWatchdog(peer: Peer): void {
    clearTimeout(peer.watchdog);
    peer.watchdog = window.setTimeout(() => {
      if (this.closed || peer.pc.connectionState === 'connected' || peer.pc.connectionState === 'closed') return;
      if (peer.restarts >= MAX_ICE_RESTARTS) return;
      peer.restarts++;
      log('watchdog: restartIce', peer.restarts, peer.pc.connectionState);
      peer.pc.restartIce();
      this.armWatchdog(peer);
    }, ICE_WATCHDOG_MS);
  }

  private closePeer(connectionId: string): void {
    const p = this.peers.get(connectionId);
    if (!p) return;
    clearTimeout(p.watchdog);
    p.pc.close();
    for (const a of p.audios.values()) {
      a.el.pause();
      a.el.srcObject = null;
      a.gain?.disconnect();
    }
    this.peers.delete(connectionId);
  }

  private signal(to: string, signal: RtcSignal): void {
    log('send', signal.type, 'para', to.slice(-4));
    this.gw.emit('rtc.signal', { conversation_id: this.conversationId, to_connection_id: to, signal });
  }

  private analyse(stream: MediaStream): AnalyserNode | null {
    try {
      const src = this.audioCtx.createMediaStreamSource(stream);
      const an = this.audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      return an;
    } catch {
      return null;
    }
  }

  private detectSpeaking(): void {
    const heard = this.micProc?.hasGate ? this.micProc.speaking : !!this.localAnalyser && level(this.localAnalyser) > SPEAKING_THRESHOLD;
    const local = heard && !this.muted && !this.deafened;
    let changed = local !== this.localSpeaking;
    this.localSpeaking = local;
    for (const p of this.peers.values()) {
      // Só a voz conta (o áudio do jogo/vídeo da tela não acende o "falando").
      let speaking = false;
      if (!this.deafened) {
        for (const a of p.audios.values()) {
          if (a.analyser && !a.stream.getVideoTracks().length && level(a.analyser) > SPEAKING_THRESHOLD) speaking = true;
        }
      }
      if (speaking !== p.speaking) changed = true;
      p.speaking = speaking;
    }
    // Só redesenha quando alguém começa/para de falar.
    if (changed) this.onChange();
  }
}

function removeSenders(pc: RTCPeerConnection, senders: RTCRtpSender[]): void {
  for (const sender of senders) {
    try {
      pc.removeTrack(sender);
    } catch {
      /* peer já fechado */
    }
  }
}

function level(an: AnalyserNode): number {
  const buf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / buf.length);
}

function preferCodec(tr: RTCRtpTransceiver, mime: string): void {
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps || !tr.setCodecPreferences) return;
  const preferred = caps.codecs.filter((c) => c.mimeType === mime);
  if (!preferred.length) return;
  try {
    tr.setCodecPreferences([...preferred, ...caps.codecs.filter((c) => c.mimeType !== mime)]);
  } catch {
    /* codec indisponível: mantém o padrão */
  }
}
