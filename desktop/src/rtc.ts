import type { CallInfo, RtcSignal } from '../../shared/protocol.ts';
import type { GatewayClient } from './gateway.ts';

export type ScreenPreset = '720p30' | '1080p30' | '1080p60';

export const SCREEN_PRESETS: Record<ScreenPreset, { width: number; height: number; fps: number; bitrate: number; label: string }> = {
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_500_000, label: '720p 30fps' },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 4_000_000, label: '1080p 30fps' },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 6_000_000, label: '1080p 60fps' },
};

export type RemotePeer = {
  connectionId: string;
  userId: string;
  state: RTCPeerConnectionState;
  screen: MediaStream | null;
  speaking: boolean;
};

type Peer = {
  pc: RTCPeerConnection;
  userId: string;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  audioEls: Map<string, HTMLAudioElement>; // stream.id -> <audio>
  screen: MediaStream | null;
  screenSenders: RTCRtpSender[];
  analyser: AnalyserNode | null;
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
  localSpeaking = false;
  onChange: () => void = () => {};
  /** Transmissão parada pelo botão do sistema (fora do app). */
  onScreenEnded: () => void = () => {};

  private ready = false;
  private gw: GatewayClient;
  private myConnectionId: string;
  private mic: MediaStream | null = null;
  private peers = new Map<string, Peer>();
  private speakerId: string | undefined;
  private audioCtx = new AudioContext();
  private localAnalyser: AnalyserNode | null = null;
  private vadTimer = 0;
  private closed = false;

  constructor(gw: GatewayClient, conversationId: string, myConnectionId: string) {
    this.gw = gw;
    this.conversationId = conversationId;
    this.myConnectionId = myConnectionId;
  }

  async start(micId?: string, speakerId?: string): Promise<void> {
    this.speakerId = speakerId;
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micId ? { ideal: micId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.localAnalyser = this.analyse(this.mic);
    this.vadTimer = window.setInterval(() => this.detectSpeaking(), 150);
    this.ready = true;
  }

  remotes(): RemotePeer[] {
    return [...this.peers.entries()].map(([connectionId, p]) => ({
      connectionId,
      userId: p.userId,
      state: p.pc.connectionState,
      screen: p.screen,
      speaking: p.speaking,
    }));
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
    this.muted = muted;
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted && !this.deafened;
    this.onChange();
  }

  /** Deafen: não ouve ninguém e também não fala (como no Discord). */
  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    for (const p of this.peers.values()) for (const el of p.audioEls.values()) el.muted = deafened;
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
      for (const sender of peer.screenSenders) {
        try {
          peer.pc.removeTrack(sender);
        } catch {
          /* peer já fechado */
        }
      }
      peer.screenSenders = [];
    }
    this.onChange();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.vadTimer);
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    for (const t of this.screen?.getTracks() ?? []) t.stop();
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
      audioEls: new Map(),
      screen: null,
      screenSenders: [],
      analyser: null,
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
        peer.screen = stream;
        stream.onremovetrack = () => {
          if (!stream.getVideoTracks().length) peer.screen = null;
          this.onChange();
        };
      } else if (!peer.audioEls.has(stream.id)) {
        // Um <audio> por stream: voz e áudio do sistema da tela tocam separados.
        const el = new Audio();
        el.srcObject = stream;
        el.muted = this.deafened;
        if (this.speakerId) el.setSinkId(this.speakerId).catch(() => {});
        el.play().catch((e) => console.warn('[rtc] play', e));
        peer.audioEls.set(stream.id, el);
        if (!peer.analyser) peer.analyser = this.analyse(stream);
      }
      this.onChange();
    };

    for (const t of this.mic?.getTracks() ?? []) pc.addTrack(t, this.mic!);
    if (this.screen && this.screenCfg) this.attachScreen(peer, this.screenCfg.bitrate, this.screenCfg.fps);
    return peer;
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
    for (const el of p.audioEls.values()) {
      el.pause();
      el.srcObject = null;
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
    const local = !!this.localAnalyser && !this.muted && !this.deafened && level(this.localAnalyser) > SPEAKING_THRESHOLD;
    let changed = local !== this.localSpeaking;
    this.localSpeaking = local;
    for (const p of this.peers.values()) {
      const speaking = !!p.analyser && !this.deafened && level(p.analyser) > SPEAKING_THRESHOLD;
      if (speaking !== p.speaking) changed = true;
      p.speaking = speaking;
    }
    // Só redesenha quando alguém começa/para de falar.
    if (changed) this.onChange();
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
