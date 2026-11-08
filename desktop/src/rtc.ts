import type { CallInfo, RtcSignal } from '../../shared/protocol.ts';
import type { GatewayClient } from './gateway.ts';
import { MIC_SAMPLE_RATE, MicProcessor, micConstraints, type MicSettings } from './mic.ts';

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

export type CallDiagnostics = {
  mic: {
    found: boolean;
    label: string;
    state: string;
    muted: boolean;
    deafened: boolean;
    sending: boolean;
    context: string;
    processing: string;
    level: number | null;
    echo: boolean | null;
    localIps: string[];
  };
  peers: {
    userId: string;
    connection: string;
    ice: string;
    gathering: string;
    pair: string;
    local: string[];
    remote: string[];
    outKbps: number | null;
    inKbps: number | null;
    inLevel: number;
  }[];
  log: string[];
};

type RemoteAudio = {
  stream: MediaStream;
  el: HTMLAudioElement;
  gain: GainNode | null;
  analyser: AnalyserNode | null;
  src: MediaStreamAudioSourceNode | null;
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
  /** Endereços próprios descobertos (0 por muito tempo = conexão travada). */
  localCands: number;
  /** Já esperou a primeira oferta do outro lado. */
  waitedOffer?: boolean;
  /** Quantas vezes esta conexão já foi recriada do zero. */
  rebuilds: number;
};

const SPEAKING_THRESHOLD = 0.02;
const ICE_WATCHDOG_MS = 8000;
const MAX_ICE_RESTARTS = 3;
const MAX_REBUILDS = 4;

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
  // 48 kHz: a supressão de ruído por IA exige (o mesmo contexto também toca o áudio dos outros).
  private audioCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
  private localAnalyser: AnalyserNode | null = null;
  private vadTimer = 0;
  private closed = false;

  constructor(gw: GatewayClient, conversationId: string, myConnectionId: string) {
    this.gw = gw;
    this.conversationId = conversationId;
    this.myConnectionId = myConnectionId;
  }

  /** Sem microfone a call continua funcionando só para ouvir (e ver/transmitir tela). Devolve o erro do microfone, se houve. */
  private localIps: string[] = [];

  async start(opts: CallOptions): Promise<Error | null> {
    this.opts = opts;
    this.localIps = ((await window.native.localAddresses?.().catch(() => [])) ?? []).map((a) => a.ip);
    if (opts.playback === 'webaudio' && opts.speakerId) {
      const ctx = this.audioCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      await ctx.setSinkId?.(opts.speakerId).catch((e) => console.warn('[rtc] saída', e));
    }
    let micError: Error | null = null;
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(opts.micId, opts.mic.noise) });
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
    if (signal.type === 'reset') {
      // O outro lado recriou a conexão dele: recria a minha também (sem avisar de volta).
      log('reset pedido por', fromConnectionId.slice(-4));
      this.rebuildPeer(fromConnectionId, peer.userId, peer.rebuilds, false);
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

  // ---- diagnóstico (🩺 na call) ----

  private lastBytes = new Map<string, { at: number; out: number; in: number }>();

  /** Fotografia da call para o painel de diagnóstico (e para copiar e mandar pra quem ajuda). */
  async diagnostics(): Promise<CallDiagnostics> {
    const track = this.mic?.getAudioTracks()[0];
    const settings = track?.getSettings();
    const mic: CallDiagnostics['mic'] = {
      found: !this.noMic,
      label: track?.label ?? '',
      state: track?.readyState ?? 'sem microfone',
      muted: this.muted,
      deafened: this.deafened,
      sending: !!this.send?.getAudioTracks()[0]?.enabled,
      context: this.audioCtx.state,
      processing: this.micProc ? (this.micProc.activeNoise as string) : 'nenhum',
      level: this.micProc ? Math.round(this.micProc.db) : null,
      echo: typeof settings?.echoCancellation === 'boolean' ? settings.echoCancellation : null,
      localIps: this.localIps,
    };
    const peers: CallDiagnostics['peers'] = [];
    for (const [connId, p] of this.peers) {
      const st = await p.pc.getStats();
      const local: string[] = [];
      const remote: string[] = [];
      const byId = new Map<string, Record<string, unknown>>();
      st.forEach((r) => byId.set(r.id, r as Record<string, unknown>));
      let pair = '';
      let out = 0;
      let inn = 0;
      let inLevel = 0;
      const cand = (r: Record<string, unknown> | undefined) =>
        r ? `${r.candidateType} ${r.address || '?'}:${r.port}${r.networkType ? ` (${r.networkType})` : ''}` : '?';
      st.forEach((r: Record<string, unknown>) => {
        if (r.type === 'local-candidate') local.push(cand(r));
        if (r.type === 'remote-candidate') remote.push(cand(r));
        if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') {
          pair = `${cand(byId.get(r.localCandidateId as string))} ⇄ ${cand(byId.get(r.remoteCandidateId as string))} · rtt ${Math.round(((r.currentRoundTripTime as number) ?? 0) * 1000)} ms`;
        }
        if (r.type === 'outbound-rtp' && r.kind === 'audio') out += (r.bytesSent as number) ?? 0;
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          inn += (r.bytesReceived as number) ?? 0;
          inLevel = Math.max(inLevel, (r.audioLevel as number) ?? 0);
        }
      });
      const now = performance.now();
      const prev = this.lastBytes.get(connId);
      this.lastBytes.set(connId, { at: now, out, in: inn });
      const kbps = (b: number, a: number) => (prev && now > prev.at ? Math.round(((b - a) * 8) / (now - prev.at)) : null);
      peers.push({
        userId: p.userId,
        connection: p.pc.connectionState,
        ice: p.pc.iceConnectionState,
        gathering: p.pc.iceGatheringState,
        pair: pair || 'nenhum caminho funcionando ainda',
        local: [...new Set(local)],
        remote: [...new Set(remote)],
        outKbps: kbps(out, prev?.out ?? 0),
        inKbps: kbps(inn, prev?.in ?? 0),
        inLevel: Math.round(inLevel * 100),
      });
    }
    return { mic, peers, log: rtcLog.slice(-40) };
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

  /** `audioApps` (só Linux): transmitir o som só desses apps; vazio/ausente = o PC todo. */
  // ---- gravação: mistura de todo mundo (antes do volume de cada um) + meu microfone ----

  private recDest: MediaStreamAudioDestinationNode | null = null;
  private recLocal: AudioNode[] = [];

  /** Áudio da call inteira para gravar/clipar. Chamar stopMixForRecording() no fim. */
  mixForRecording(): MediaStream {
    if (!this.recDest) {
      this.recDest = this.audioCtx.createMediaStreamDestination();
      for (const peer of this.peers.values()) for (const a of peer.audios.values()) a.src?.connect(this.recDest);
      this.refreshLocalRecording();
    }
    this.recUsers++;
    return this.recDest.stream;
  }
  private recUsers = 0;

  /** Meu microfone (já tratado, mudo quando estou mutado) e o áudio da minha tela. */
  private refreshLocalRecording(): void {
    if (!this.recDest) return;
    for (const n of this.recLocal) n.disconnect();
    this.recLocal = [];
    for (const st of [this.send, this.screen]) {
      if (!st?.getAudioTracks().length) continue;
      const n = this.audioCtx.createMediaStreamSource(new MediaStream(st.getAudioTracks()));
      n.connect(this.recDest);
      this.recLocal.push(n);
    }
  }

  stopMixForRecording(): void {
    if (--this.recUsers > 0 || !this.recDest || this.closed) return;
    for (const peer of this.peers.values()) for (const a of peer.audios.values()) {
      try {
        a.src?.disconnect(this.recDest);
      } catch {
        /* já desligado */
      }
    }
    for (const n of this.recLocal) n.disconnect();
    this.recLocal = [];
    this.recDest = null;
    this.recUsers = 0;
  }

  /** Transmite uma stream pronta (ex.: arquivo de vídeo tocando) como se fosse a tela. */
  async startCustomScreen(stream: MediaStream, preset: ScreenPreset, hint: 'detail' | 'motion', onStop?: () => void): Promise<void> {
    const cfg = SCREEN_PRESETS[preset];
    this.stopScreen();
    this.screen = stream;
    this.screenOnStop = onStop ?? null;
    const video = stream.getVideoTracks()[0];
    if (video) video.contentHint = hint;
    for (const [, peer] of this.peers) this.attachScreen(peer, cfg.bitrate, cfg.fps);
    this.screenCfg = cfg;
    this.refreshLocalRecording();
    this.onChange();
  }
  private screenOnStop: (() => void) | null = null;

  async startScreen(preset: ScreenPreset, withAudio: boolean, hint: 'detail' | 'motion', audioApps?: string[], includeVoiceApps = false): Promise<void> {
    const cfg = SCREEN_PRESETS[preset];
    // No Linux o áudio vem de uma fonte virtual do PipeWire (o loopback do Chromium só existe no Windows).
    const linuxAudio = withAudio && !!window.native?.shareAudioStart;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: cfg.width }, height: { ideal: cfg.height }, frameRate: { ideal: cfg.fps, max: cfg.fps } },
      audio: withAudio && !linuxAudio,
    });
    if (linuxAudio) {
      try {
        stream.addTrack(await captureLinuxSystemAudio(audioApps, includeVoiceApps));
      } catch (e) {
        for (const t of stream.getTracks()) t.stop();
        window.native.shareAudioStop?.();
        throw e;
      }
    }
    this.stopScreen();
    this.screen = stream;
    this.screenLinuxAudio = linuxAudio;
    this.refreshLocalRecording();
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
    if (this.screenLinuxAudio) window.native.shareAudioStop?.();
    this.screenLinuxAudio = false;
    this.screen = null;
    this.screenCfg = null;
    const stopped = this.screenOnStop;
    this.screenOnStop = null;
    stopped?.();
    this.refreshLocalRecording();
    // Remove as tracks da tela (vídeo e, no Windows, o áudio do sistema) → renegocia.
    for (const peer of this.peers.values()) {
      removeSenders(peer.pc, peer.screenSenders);
      peer.screenSenders = [];
    }
    this.onChange();
  }

  async startCamera(deviceId?: string): Promise<void> {
    // Celular: não força 16:9 deitado (o Android recortaria a imagem com o aparelho em pé).
    // Pede só o tamanho máximo e deixa a câmera mandar no formato dela, sem recorte.
    const phone = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const size: MediaTrackConstraints = phone
      ? { width: { max: CAMERA.width }, height: { max: CAMERA.width }, resizeMode: { ideal: 'none' } } as MediaTrackConstraints
      : { width: { ideal: CAMERA.width }, height: { ideal: CAMERA.height } };
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { ideal: deviceId } : undefined,
        facingMode: deviceId ? undefined : 'user',
        ...size,
        frameRate: { ideal: CAMERA.fps, max: CAMERA.fps },
      },
    });
    // "Afastamento de leve": se a câmera deixa controlar o zoom, usa o menor (mais aberto).
    await zoomOut(stream.getVideoTracks()[0]);
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
    if (this.screenLinuxAudio) window.native.shareAudioStop?.();
    for (const t of this.camera?.getTracks() ?? []) t.stop();
    this.micProc?.destroy();
    this.audioCtx.close();
  }

  // ---- internos ----

  private screenCfg: { bitrate: number; fps: number } | null = null;
  private screenLinuxAudio = false;

  private createPeer(connectionId: string, userId: string, rebuilds = 0): Peer {
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
      localCands: 0,
      rebuilds,
    };
    this.peers.set(connectionId, peer);
    this.armWatchdog(peer);

    pc.onnegotiationneeded = async () => {
      // Primeira negociação: só o lado "não educado" oferece; o outro espera a oferta dele.
      // Duas ofertas cruzadas (colisão) deixavam a conexão do celular sem coletar endereços.
      if (peer.polite && !pc.remoteDescription && !pc.localDescription && !peer.waitedOffer) {
        peer.waitedOffer = true;
        log('espera a oferta de', connectionId.slice(-4));
        // Se a oferta não vier (outro lado antigo/travado), oferece mesmo assim.
        window.setTimeout(() => {
          if (this.peers.get(connectionId) === peer && !pc.remoteDescription && !pc.localDescription && pc.signalingState === 'stable') {
            pc.onnegotiationneeded?.(new Event('negotiationneeded'));
          }
        }, 3000);
        return;
      }
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
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) peer.localCands++;
      const c = candidate?.toJSON() ?? null;
      // Celular: o WebView esconde o IP atrás de um nome .local (não funciona pela VPN).
      // Manda também o mesmo candidato com cada IP real do aparelho; os que não servirem são ignorados.
      const parts = c?.candidate?.split(' ');
      if (c && parts && parts.length > 5 && parts[4].endsWith('.local') && this.localIps.length) {
        for (const ip of this.localIps) {
          const copy = [...parts];
          copy[4] = ip;
          this.signal(connectionId, { type: 'candidate', candidate: { ...c, candidate: copy.join(' ') } });
        }
        log('cand .local trocado por', this.localIps.join(','));
      }
      this.signal(connectionId, { type: 'candidate', candidate: c });
    };
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
    let src: MediaStreamAudioSourceNode | null = null;
    try {
      src = this.audioCtx.createMediaStreamSource(stream);
      if (this.recDest) src.connect(this.recDest);
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
    return { stream, el, gain, analyser, src };
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
      const connId = [...this.peers.entries()].find(([, p]) => p === peer)?.[0];
      if (!connId) return;
      // Nenhum endereço próprio descoberto: essa conexão não se recupera (nem com restartIce).
      // Joga fora e cria outra do zero, avisando o outro lado pra fazer o mesmo.
      if ((peer.localCands === 0 && peer.pc.localDescription) || peer.restarts >= MAX_ICE_RESTARTS) {
        if (peer.rebuilds >= MAX_REBUILDS) return;
        log('watchdog: recriando conexão', 'locais=' + peer.localCands, 'restarts=' + peer.restarts);
        this.rebuildPeer(connId, peer.userId, peer.rebuilds + 1, true);
        return;
      }
      peer.restarts++;
      log('watchdog: restartIce', peer.restarts, peer.pc.connectionState);
      peer.pc.restartIce();
      this.armWatchdog(peer);
    }, ICE_WATCHDOG_MS);
  }

  /** Conexão nova no lugar da travada (mesma pessoa). `tell`: avisa o outro lado pra recriar também. */
  private rebuildPeer(connectionId: string, userId: string, rebuilds: number, tell: boolean): void {
    this.closePeer(connectionId);
    if (tell) this.signal(connectionId, { type: 'reset' });
    this.createPeer(connectionId, userId, rebuilds);
    this.onChange();
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

/** Linux: cria a fonte virtual (no processo principal) e abre ela como se fosse um microfone. */
async function captureLinuxSystemAudio(only?: string[], includeVoiceApps = false): Promise<MediaStreamTrack> {
  const label = await window.native.shareAudioStart!(only?.length ? only : null, includeVoiceApps);
  // O Chromium leva um instante para enxergar o dispositivo novo.
  for (let i = 0; i < 20; i++) {
    const dev = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.label === label);
    if (dev) {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: dev.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
      return s.getAudioTracks()[0];
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('a fonte de áudio virtual não apareceu');
}

/** Zoom mínimo, quando o aparelho deixa controlar (a maioria dos celulares Android). */
async function zoomOut(track: MediaStreamTrack | undefined): Promise<void> {
  if (!track?.getCapabilities) return;
  const caps = track.getCapabilities() as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
  const current = (track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom;
  if (!caps.zoom || current === undefined || current <= caps.zoom.min) return;
  await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min } as MediaTrackConstraintSet] }).catch(() => {});
}
