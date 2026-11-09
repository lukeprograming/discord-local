import { useSyncExternalStore } from 'react';
import type {
  CallInfo,
  Conversation,
  Friend,
  Message,
  Presence,
  UserPublic,
  VoiceAttachment,
  FileAttachment,
  Attachment,
  MediaAction,
  Sound,
  UserStatus,
  InviteInfo,
  PollAttachment,
  ActivityName,
  TurnServerInfo,
  ShareRequest,
  ShareResponse,
  ClientOps,
} from '../../shared/protocol.ts';
import { isMutation, MAX_MESSAGE_LENGTH } from '../../shared/protocol.ts';
import { checkServer, GatewayClient, httpPost } from './gateway.ts';
import { CallSession, type AudioKind, type ScreenPreset } from './rtc.ts';
import { DEFAULT_NOISE, type MicSettings } from './mic.ts';
import { ulid } from './ulid.ts';
import { autoDownload, formatSize, initFiles } from './files.ts';
import { accelFromEvent, hotkeyOf, mainKey } from './hotkeys.ts';
import { playSound } from './sounds.ts';
import { isRecording, saveClip, startVideoFile, stopAllRecording } from './recorder.ts';
import { scheduleAllReminders, scheduleReminder } from './reminders.ts';
import type { EmbeddedConfig, HostConfig, HostStatus, Profile, Settings, UpdateStatus } from './native.d.ts';

/** Celular costuma ficar longe da boca: nivelador ligado por padrão lá. */
const LEVEL_DEFAULT = /Android/i.test(navigator.userAgent);

export function micSettings(s: Settings | undefined): MicSettings {
  return {
    volume: s?.mic_volume ?? 1,
    threshold: s?.mic_threshold ?? null,
    noise: s?.mic_noise ?? DEFAULT_NOISE,
    level: s?.mic_level ?? LEVEL_DEFAULT,
  };
}

/** Erros vindos do processo principal chegam com prefixo do Electron. */
export function errorMessage(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Traduz o erro do getUserMedia para algo que dá pra resolver. */
function micErrorMessage(e: Error, platform: string): string {
  switch (e.name) {
    case 'NotAllowedError':
      return platform === 'android'
        ? 'Sem permissão para usar o microfone. Libere em Configurações do Android → Apps → Discord Local → Permissões.'
        : 'Sem permissão para usar o microfone. No Windows: Configurações → Privacidade → Microfone → permitir apps da área de trabalho.';
    case 'NotFoundError':
      return 'Nenhum microfone encontrado. Conecte ou ative um microfone e tente de novo.';
    case 'NotReadableError':
      return 'O microfone está ocupado ou travado por outro programa.';
    default:
      return `Microfone indisponível: ${e.message}`;
  }
}

export type State = {
  booted: boolean;
  profile: Profile | null;
  connection: 'offline' | 'connecting' | 'online';
  connectionId: string | null;
  friends: Friend[];
  conversations: Conversation[];
  presences: Record<string, Presence>;
  calls: Record<string, CallInfo>;
  messages: Record<string, Message[]>; // só das conversas já abertas
  outbox: Message[];
  selected: string | null;
  unread: Record<string, number>;
  typing: Record<string, Record<string, number>>; // conv -> user -> expira em
  ringing: { conversation_id: string; from_user_id: string } | null;
  call: CallSession | null;
  callError: string | null;
  toast: string | null;
  platform: string;
  embedded: EmbeddedConfig | null; // veio de instalador exportado por um host
  host: HostStatus; // servidor embutido (só no modo host)
  hostBusy: boolean;
  /** Tamanho da transmissão: normal (divide com o chat), wide (sem chat), theater (sem chat nem lateral). */
  stage: 'normal' | 'wide' | 'theater';
  update: UpdateStatus;
  /** Celular: som da call no alto-falante (senão no fone de ouvido). */
  speaker: boolean;
  statuses: Record<string, UserStatus>;
  sounds: Sound[];
  admin: boolean;
  /** Mensagem para rolar até quando a conversa abrir (vinda da busca). */
  jumpTo: { conversationId: string; messageId: string } | null;
  /** Retransmissores TURN dos PCs conectados. */
  turnServers: TurnServerInfo[];
  /** Painel da direita: aberto/fechado e qual aba. */
  panelOpen: boolean;
  panelTab: PanelTab;
  /** Tela do centro quando nenhuma conversa está aberta (null = só a lista, no celular). */
  page: Page | null;
  friendsTab: FriendsTab;
  /** Conversas abertas em abas (min = recolhida: some da barra, mas continua montada). */
  tabs: Tab[];
  /** Janela sem moldura (barra de título nossa) e se está maximizada. */
  frameless: boolean;
  maximized: boolean;
  version: string;
};

export type Tab = { id: string; min: boolean };
const MAX_TABS = 8;

function loadTabs(): Tab[] {
  try {
    const v = JSON.parse(localStorage.getItem('tabs') || '[]');
    return Array.isArray(v) ? v.filter((t) => typeof t?.id === 'string').slice(0, MAX_TABS) : [];
  } catch {
    return [];
  }
}

export type Page = 'home' | 'friends' | 'downloads';
export type FriendsTab = 'online' | 'all' | 'requests' | 'add';

/** Abas do painel da direita (as de ferramenta só valem dentro de uma call). */
export type PanelTab = 'people' | 'music' | 'games' | 'sounds' | 'record' | 'diag';

function initialPanelOpen(): boolean {
  try {
    const v = localStorage.getItem('panel-open');
    if (v !== null) return v === '1';
  } catch {
    /* sem storage */
  }
  return window.innerWidth >= 1600; // telas menores começam com mais espaço pro centro
}

type Listener = () => void;

const TYPING_TTL_MS = 6000;

class App {
  state: State = {
    booted: false,
    profile: null,
    connection: 'offline',
    connectionId: null,
    friends: [],
    conversations: [],
    presences: {},
    calls: {},
    messages: {},
    outbox: [],
    selected: null,
    unread: {},
    typing: {},
    ringing: null,
    call: null,
    callError: null,
    toast: null,
    platform: '',
    embedded: null,
    host: { running: false },
    hostBusy: false,
    stage: 'normal',
    update: { state: 'idle', current: '' },
    speaker: true,
    statuses: {},
    sounds: [],
    admin: false,
    jumpTo: null,
    turnServers: [],
    panelOpen: initialPanelOpen(),
    panelTab: 'people',
    page: null,
    friendsTab: 'online',
    tabs: loadTabs(),
    frameless: false,
    maximized: false,
    version: '',
  };

  private listeners = new Set<Listener>();
  private gw: GatewayClient | null = null;
  private flushing = false;
  private pendingAcks: string[] = [];
  private ackTimer = 0;
  private toastTimer = 0;
  private lastTypingSent = 0;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Força re-render (ex.: estado interno da CallSession mudou). */
  private bump(): void {
    this.set({});
  }

  toast(msg: string): void {
    clearTimeout(this.toastTimer);
    this.set({ toast: msg });
    this.toastTimer = window.setTimeout(() => this.set({ toast: null }), 4000);
  }

  me(): UserPublic | null {
    return this.state.profile?.user ?? null;
  }

  user(id: string): UserPublic | undefined {
    if (id === this.me()?.id) return this.me()!;
    for (const c of this.state.conversations) {
      const u = c.members.find((m) => m.id === id);
      if (u) return u;
    }
    return this.state.friends.find((f) => f.user.id === id)?.user;
  }

  conversationTitle(c: Conversation): string {
    if (c.type === 'ROOM') return c.name ?? 'Sala';
    if (c.type === 'GROUP') return c.name ?? 'Grupo';
    const other = c.members.find((m) => m.id !== this.me()?.id);
    return other?.display_name ?? 'Conversa';
  }

  // ---- status, menções, silenciar ----

  myStatus(): UserStatus {
    const id = this.me()?.id;
    return (id && this.state.statuses[id]) || { availability: 'online', text: '', emoji: '' };
  }

  statusOf(userId: string): UserStatus | undefined {
    return this.state.statuses[userId];
  }

  async setStatus(status: UserStatus): Promise<void> {
    this.autoIdle = false;
    await this.requireOnline().request('status.set', { status });
  }

  /** Ausente sozinho depois de 10 min sem mexer no PC (e volta quando mexer). */
  private autoIdle = false;
  private watchIdle(): void {
    if (!window.native.idleSeconds) return;
    window.setInterval(async () => {
      if (this.state.connection !== 'online') return;
      const idle = await window.native.idleSeconds!();
      const st = this.myStatus();
      if (!this.autoIdle && st.availability === 'online' && idle >= 600) {
        this.autoIdle = true;
        this.gw?.request('status.set', { status: { ...st, availability: 'idle' } }).catch(() => {});
      } else if (this.autoIdle && idle < 30) {
        this.autoIdle = false;
        if (st.availability === 'idle') this.gw?.request('status.set', { status: { ...st, availability: 'online' } }).catch(() => {});
      }
    }, 30_000);
  }

  /**
   * Celular com a tela apagada/app em segundo plano: o Android dá menos CPU ao app e a
   * supressão de ruído por IA atrasa (voz abafada/picotada). Troca pela nativa enquanto
   * estiver escondido e volta a IA quando o app reaparece.
   */
  private watchBackground(): void {
    if (!/Android/i.test(navigator.userAgent)) return;
    document.addEventListener('visibilitychange', () => {
      const call = this.state.call;
      if (!call) return;
      const s = micSettings(this.state.profile?.settings);
      const heavy = s.noise === 'gtcrn' || s.noise === 'rnnoise';
      if (document.hidden && heavy) call.setMicSettings({ ...s, noise: 'native' });
      else call.setMicSettings(s);
    });
  }

  mentionsMe(text: string): boolean {
    const me = this.me();
    if (!me) return false;
    return new RegExp(`(^|[^\\w@])@(${me.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|todos|everyone)\\b`, 'i').test(text);
  }

  isFavConversation(id: string): boolean {
    return !!this.state.profile?.settings?.fav_conversations?.includes(id);
  }

  async toggleFavConversation(id: string): Promise<void> {
    const list = this.state.profile?.settings?.fav_conversations ?? [];
    await this.saveSettings({ fav_conversations: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
  }

  isFavMessage(id: string): boolean {
    return !!this.state.profile?.settings?.fav_messages?.some((f) => f.m === id);
  }

  async toggleFavMessage(conversationId: string, id: string): Promise<void> {
    const list = this.state.profile?.settings?.fav_messages ?? [];
    await this.saveSettings({
      fav_messages: list.some((f) => f.m === id) ? list.filter((f) => f.m !== id) : [...list, { c: conversationId, m: id }],
    });
  }

  isMuted(conversationId: string): boolean {
    return !!this.state.profile?.settings?.muted_conversations?.includes(conversationId);
  }

  async toggleMuteConversation(conversationId: string): Promise<void> {
    const list = this.state.profile?.settings?.muted_conversations ?? [];
    await this.saveSettings({
      muted_conversations: list.includes(conversationId) ? list.filter((x) => x !== conversationId) : [...list, conversationId],
    });
  }

  // ---- salas e soundboard ----

  /** PC: liga o retransmissor e anuncia pros outros (os celulares da casa usam). */
  private async announceTurn(): Promise<void> {
    if (!window.native.turnInfo || !this.state.profile) return;
    try {
      const host = new URL(this.state.profile.server_url).hostname;
      const info = await window.native.turnInfo(host);
      if (!info) return;
      await this.gw?.request('turn.announce', { urls: info.urls, username: info.username, credential: info.credential });
    } catch (e) {
      console.warn('[turn] anúncio', e);
    }
  }

  /** iceServers para as conexões da call: retransmissores dos outros PCs. */
  iceServers(): RTCIceServer[] {
    return this.state.turnServers
      .filter((t) => t.connection_id !== this.state.connectionId)
      .map((t) => ({ urls: t.urls, username: t.username, credential: t.credential }));
  }

  // ---- jogos da call ----

  private activityListeners = new Set<(activity: ActivityName, event: Record<string, unknown>, userId: string) => void>();

  onActivity(cb: (activity: ActivityName, event: Record<string, unknown>, userId: string) => void): () => void {
    this.activityListeners.add(cb);
    return () => this.activityListeners.delete(cb);
  }

  async activityLog(activity: ActivityName): Promise<{ event: Record<string, unknown>; user_id: string }[]> {
    const call = this.state.call;
    if (!call) return [];
    return (await this.requireOnline().request('call.activity.log', { conversation_id: call.conversationId, activity })).events;
  }

  async sendActivity(activity: ActivityName, event: Record<string, unknown>): Promise<void> {
    const call = this.state.call;
    if (!call) throw new Error('Entre numa call para jogar');
    await this.requireOnline().request('call.activity', { conversation_id: call.conversationId, activity, event });
  }

  // ---- pasta compartilhada (tratada em src/share.ts) ----

  shareRequest?: (d: { from_user_id: string; req_id: string; req: ShareRequest }) => void;
  shareResponse?: (d: { from_user_id: string; req_id: string; res: ShareResponse }) => void;

  async shareSend<K extends 'share.request' | 'share.response'>(op: K, d: ClientOps[K]): Promise<void> {
    await this.requireOnline().request(op, d);
  }

  async listInvites(): Promise<InviteInfo[]> {
    return (await this.requireOnline().request('invite.list', {})).invites;
  }

  async revokeInvite(code: string): Promise<void> {
    await this.requireOnline().request('invite.revoke', { code });
  }

  async createRoom(name: string): Promise<Conversation> {
    const { conversation } = await this.requireOnline().request('room.create', { name });
    return conversation;
  }

  async renameRoom(conversationId: string, name: string): Promise<void> {
    await this.requireOnline().request('room.rename', { conversation_id: conversationId, name });
  }

  async deleteRoom(conversationId: string): Promise<void> {
    await this.requireOnline().request('room.delete', { conversation_id: conversationId });
  }

  async playSoundForAll(soundId: string): Promise<void> {
    const call = this.state.call;
    if (!call) throw new Error('Entre numa call para usar o soundboard');
    await this.requireOnline().request('call.sound', { conversation_id: call.conversationId, sound_id: soundId });
  }

  async deleteSound(id: string): Promise<void> {
    await this.requireOnline().request('sound.delete', { id });
  }

  async openMessage(conversationId: string, messageId: string): Promise<void> {
    await this.select(conversationId);
    this.set({ jumpTo: { conversationId, messageId } });
  }

  clearJump(): void {
    if (this.state.jumpTo) this.set({ jumpTo: null });
  }

  userByUsername(username: string): UserPublic | undefined {
    const u = username.toLowerCase();
    for (const c of this.state.conversations) for (const m of c.members) if (m.username.toLowerCase() === u) return m;
    return this.state.friends.find((f) => f.user.username.toLowerCase() === u)?.user;
  }

  directPeer(c: Conversation): UserPublic | undefined {
    return c.type === 'DIRECT' ? c.members.find((m) => m.id !== this.me()?.id) : undefined;
  }

  // ---- boot / login ----

  async boot(): Promise<void> {
    initFiles();
    const [stored, outbox, info, embedded, host, update] = await Promise.all([
      window.native.loadProfile(),
      window.native.loadOutbox(),
      window.native.info(),
      window.native.embedded(),
      window.native.hostStatus(),
      window.native.updateStatus(),
    ]);
    window.native.onUpdateStatus((u) => this.set({ update: u }));
    window.native.winState?.().then((w) => this.set({ frameless: w.frameless, maximized: w.maximized })).catch(() => {});
    window.native.onWinMaximized?.((maximized) => this.set({ maximized }));
    this.watchIdle();
    this.watchBackground();
    const profile = stored && { ...stored, role: stored.role ?? 'client' };
    // Offline-first: mostra o que está no cache antes de qualquer rede.
    this.set({
      booted: true,
      profile,
      outbox,
      platform: info.platform,
      version: info.version,
      embedded,
      host,
      update,
      friends: profile?.cache.friends ?? [],
      conversations: profile?.cache.conversations ?? [],
    });
    // Conectado procura o host sozinho; o host só conecta depois de iniciar a sessão.
    if (profile && (profile.role === 'client' || host.running)) this.connect(profile);
  }

  // ---- modo host ----

  /** Primeira configuração do host: sobe o servidor e cria (ou entra na) conta local. */
  async setupHost(cfg: HostConfig, account: Record<string, string>): Promise<void> {
    await this.runHost(cfg);
    const url = `http://${cfg.ip}:${cfg.port}`;
    const health = await fetch(`${url}/health`).then((r) => r.json());
    await this.authenticate(url, health.needs_setup ? 'register' : 'login', account, { role: 'host', host: cfg });
  }

  private async runHost(cfg: HostConfig): Promise<void> {
    this.set({ hostBusy: true });
    try {
      const host = await window.native.hostStart(cfg);
      this.set({ host });
    } catch (e) {
      throw new Error(errorMessage(e));
    } finally {
      this.set({ hostBusy: false });
    }
  }

  /** Botão "Iniciar sessão online": liga a VPN (se Tailscale), sobe o servidor e conecta. */
  async startSession(): Promise<void> {
    const p = this.state.profile;
    if (!p?.host) return;
    try {
      await this.runHost(p.host);
      this.connect(p);
    } catch (e) {
      this.toast(errorMessage(e));
    }
  }

  async stopSession(): Promise<void> {
    this.leaveCall();
    this.gw?.close();
    this.gw = null;
    const host = await window.native.hostStop();
    this.set({ host, connection: 'offline', connectionId: null, calls: {}, presences: {} });
  }

  /** Troca IP/VPN do host; se a sessão estava online, reinicia o servidor no endereço novo. */
  async updateHostConfig(cfg: HostConfig): Promise<void> {
    const p = this.state.profile;
    if (!p) return;
    const wasRunning = this.state.host.running;
    if (wasRunning) await this.stopSession();
    const profile = { ...p, host: cfg, server_url: `http://${cfg.ip}:${cfg.port}` };
    await window.native.saveProfile(profile);
    this.set({ profile });
    if (wasRunning) {
      await this.runHost(cfg);
      this.connect(profile);
    }
  }

  /** Gera o instalador dos amigos com o endereço deste host e um convite embutido. */
  async exportConnector(platform: 'win32' | 'linux', pickAgain = false): Promise<string | null> {
    const p = this.state.profile;
    if (!p?.host) throw new Error('Só o host exporta instalador');
    const { code } = await this.requireOnline().request('invite.create', { multi_use: true });
    try {
      return await window.native.exportConnector(
        platform,
        { server_url: p.server_url, invite_code: code, host_name: p.host.name },
        pickAgain,
      );
    } catch (e) {
      throw new Error(errorMessage(e));
    }
  }

  async authenticate(
    serverUrl: string,
    mode: 'login' | 'register',
    body: Record<string, string>,
    role: Pick<Profile, 'role' | 'host'> = { role: 'client' },
  ): Promise<void> {
    const url = serverUrl.trim().replace(/\/$/, '');
    const res = await httpPost<{ token: string; user: UserPublic }>(url, `/auth/${mode}`, {
      ...body,
      device_name: this.state.platform === 'android' ? 'android' : `desktop-${this.state.platform}`,
    });
    const prev = this.state.profile;
    // Mesmo usuário no mesmo servidor: mantém cache e configurações.
    const same = prev && prev.server_url === url && prev.user.id === res.user.id;
    const profile: Profile = {
      ...role,
      server_url: url,
      token: res.token,
      user: res.user,
      cache: same ? prev.cache : { friends: [], conversations: [] },
      settings: prev?.settings,
    };
    await window.native.saveProfile(profile);
    this.set({ profile, friends: profile.cache.friends, conversations: profile.cache.conversations });
    this.connect(profile);
  }

  async logout(): Promise<void> {
    this.leaveCall();
    this.gw?.close();
    this.gw = null;
    const p = this.state.profile;
    // Mantém o cache (histórico local continua no disco); só esquece o token.
    if (p) await window.native.saveProfile({ ...p, token: '' });
    this.set({ profile: p ? { ...p, token: '' } : null, connection: 'offline', connectionId: null });
  }

  private connect(profile: Profile): void {
    if (!profile.token) return;
    this.gw?.close();
    const gw = new GatewayClient(profile.server_url, profile.token);
    this.gw = gw;
    gw.onStatus = (connection) => {
      this.set({ connection, ...(connection !== 'online' ? { connectionId: null } : {}) });
      if (connection === 'offline' && this.state.call) {
        this.leaveCall();
        this.toast('Conexão caiu — você saiu da call');
      }
    };
    gw.onAuthFailed = () => {
      this.toast('Sessão expirada, entre de novo');
      this.logout();
    };

    gw.on('ready', (d) => {
      const calls: Record<string, CallInfo> = {};
      for (const c of d.calls) calls[c.conversation_id] = c;
      this.set({
        connectionId: d.connection_id,
        friends: d.friends,
        conversations: d.conversations,
        presences: d.presences,
        calls,
        statuses: d.statuses ?? {},
        sounds: d.sounds ?? [],
        admin: !!d.admin,
        turnServers: d.turn ?? [],
      });
      this.announceTurn();
      this.saveCache();
      this.flushOutbox();
      scheduleAllReminders();
    });
    gw.on('friends.sync', ({ friends }) => {
      const before = new Set(this.state.friends.filter((f) => f.status === 'INCOMING').map((f) => f.user.id));
      const incoming = friends.find((f) => f.status === 'INCOMING' && !before.has(f.user.id));
      if (incoming) this.notify('Pedido de amizade', `${incoming.user.display_name} quer ser seu amigo`);
      this.set({ friends });
      this.saveCache();
    });
    gw.on('conversation.upsert', ({ conversation }) => {
      const list = this.state.conversations.filter((c) => c.id !== conversation.id);
      this.set({ conversations: [...list, conversation] });
      this.saveCache();
    });
    gw.on('presence.update', ({ user_id, status }) => {
      this.set({ presences: { ...this.state.presences, [user_id]: status } });
    });
    gw.on('message.created', ({ message }) => this.receive(message));
    gw.on('status.update', ({ user_id, status }) => {
      this.set({ statuses: { ...this.state.statuses, [user_id]: status } });
    });
    gw.on('sounds.sync', ({ sounds }) => this.set({ sounds }));
    gw.on('turn.list', ({ servers }) => this.set({ turnServers: servers }));
    gw.on('call.activity', (d) => {
      if (this.state.call?.conversationId !== d.conversation_id) return;
      for (const l of this.activityListeners) l(d.activity, d.event, d.user_id);
    });
    gw.on('share.request', (d) => this.shareRequest?.(d));
    gw.on('share.response', (d) => this.shareResponse?.(d));
    gw.on('conversation.removed', ({ conversation_id }) => {
      this.set({
        conversations: this.state.conversations.filter((c) => c.id !== conversation_id),
        selected: this.state.selected === conversation_id ? null : this.state.selected,
      });
      this.saveCache();
    });
    gw.on('call.sound', ({ conversation_id, sound_id }) => {
      const call = this.state.call;
      if (call?.conversationId === conversation_id && !call.deafened) playSound(sound_id).catch(() => {});
    });
    gw.on('typing', ({ conversation_id, user_id }) => {
      const conv = { ...(this.state.typing[conversation_id] ?? {}), [user_id]: Date.now() + TYPING_TTL_MS };
      this.set({ typing: { ...this.state.typing, [conversation_id]: conv } });
      window.setTimeout(() => this.bump(), TYPING_TTL_MS + 50);
    });

    gw.on('call.update', ({ call }) => {
      this.set({ calls: { ...this.state.calls, [call.conversation_id]: call } });
      const session = this.state.call;
      if (session?.conversationId === call.conversation_id) session.sync(call);
      // Alguém atendeu em outro aparelho / a call já tem gente: para de tocar se eu entrei.
      if (this.state.ringing?.conversation_id === call.conversation_id && call.participants.some((p) => p.user_id === this.me()?.id)) {
        this.set({ ringing: null });
      }
    });
    gw.on('call.ringing', (d) => {
      if (this.state.call) return; // já estou em outra call
      this.set({ ringing: d });
      const from = this.user(d.from_user_id)?.display_name ?? 'Alguém';
      this.notify('Chamada', `${from} está ligando`);
    });
    gw.on('call.ended', ({ conversation_id }) => {
      const calls = { ...this.state.calls };
      delete calls[conversation_id];
      this.set({ calls, ringing: this.state.ringing?.conversation_id === conversation_id ? null : this.state.ringing });
      if (this.state.call?.conversationId === conversation_id) this.leaveCall(false);
    });
    gw.on('rtc.signal', (d) => {
      const s = this.state.call;
      if (s?.conversationId === d.conversation_id) s.handleSignal(d.from_connection_id, d.from_user_id, d.signal);
    });

    gw.connect();
  }

  setStage(stage: State['stage']): void {
    this.set({ stage });
  }

  // ---- abas ----

  /** Abrir uma conversa abre/mostra a aba dela; passando do limite sai a mais antiga. */
  private withTab(id: string): Tab[] {
    let tabs = this.state.tabs.some((t) => t.id === id)
      ? this.state.tabs.map((t) => (t.id === id ? { ...t, min: false } : t))
      : [...this.state.tabs, { id, min: false }];
    while (tabs.length > MAX_TABS) {
      const drop = tabs.find((t) => t.min && t.id !== id) ?? tabs.find((t) => t.id !== id)!;
      tabs = tabs.filter((t) => t !== drop);
    }
    this.saveTabs(tabs);
    return tabs;
  }

  private saveTabs(tabs: Tab[]): void {
    try {
      localStorage.setItem('tabs', JSON.stringify(tabs));
    } catch {
      /* sem storage */
    }
  }

  /** Para onde ir quando a aba atual some: a vizinha visível, ou a tela inicial. */
  private afterTabGone(tabs: Tab[], goneIndex: number): void {
    const visible = tabs.filter((t) => !t.min);
    const next = visible[Math.min(goneIndex, visible.length - 1)];
    if (next) this.select(next.id);
    else this.set({ selected: null });
  }

  /** Recolher: a aba sai da barra mas a conversa continua montada (rascunho, rolagem). */
  minimizeTab(id: string): void {
    const i = this.state.tabs.filter((t) => !t.min).findIndex((t) => t.id === id);
    const tabs = this.state.tabs.map((t) => (t.id === id ? { ...t, min: true } : t));
    this.saveTabs(tabs);
    this.set({ tabs });
    if (this.state.selected === id) this.afterTabGone(tabs, i);
  }

  /** Fechar: tira a aba de vez (a conversa continua na lateral). Não sai da call. */
  closeTab(id: string): void {
    const i = this.state.tabs.filter((t) => !t.min).findIndex((t) => t.id === id);
    const tabs = this.state.tabs.filter((t) => t.id !== id);
    this.saveTabs(tabs);
    this.set({ tabs });
    if (this.state.selected === id) this.afterTabGone(tabs, i);
  }

  /** Sino: zera as não lidas de todas as conversas. */
  markAllRead(): void {
    this.set({ unread: {} });
  }

  /** Abre uma tela do centro (Início, Amigos, Downloads) no lugar da conversa. */
  openPage(page: Page | null, friendsTab?: FriendsTab): void {
    this.set({ page, selected: null, ...(friendsTab ? { friendsTab } : {}) });
  }

  setFriendsTab(friendsTab: FriendsTab): void {
    this.set({ friendsTab });
  }

  /** Conversa direta com um amigo (o servidor cria quando a amizade é aceita). */
  directWith(userId: string): Conversation | undefined {
    return this.state.conversations.find((c) => c.type === 'DIRECT' && this.directPeer(c)?.id === userId);
  }

  /** Abre o painel da direita numa aba; clicar de novo na aba aberta fecha. */
  openPanel(tab: PanelTab, toggle = true): void {
    const { panelOpen, panelTab } = this.state;
    this.setPanelOpen(toggle && panelOpen && panelTab === tab ? false : true, tab);
  }

  setPanelOpen(open: boolean, tab = this.state.panelTab): void {
    // No celular o painel é uma gaveta por cima: não lembra aberto.
    if (window.innerWidth > 700) {
      try {
        localStorage.setItem('panel-open', open ? '1' : '0');
      } catch {
        /* sem storage */
      }
    }
    this.set({ panelOpen: open, panelTab: tab });
  }

  reconnectNow(): void {
    this.gw?.reconnectNow();
  }

  /**
   * Quem conecta: o host mudou de VPN (ZeroTier/Hamachi/Tailscale) ou de IP.
   * A conta é a mesma (mesmo servidor), só o endereço muda.
   */
  async changeServer(input: string): Promise<string> {
    const p = this.state.profile;
    if (!p) throw new Error('sem perfil');
    let url = input.trim();
    if (!url) throw new Error('digite o endereço do host');
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error('endereço inválido (ex.: 10.147.18.244 ou 25.20.177.202:47200)');
    }
    if (!u.port) u.port = new URL(p.server_url).port || '47200';
    const server = `${u.protocol}//${u.host}`;
    await checkServer(server); // responde? (erro claro se não)
    if (this.state.call) this.leaveCall();
    const profile = { ...p, server_url: server };
    await window.native.saveProfile(profile);
    this.set({ profile });
    this.connect(profile);
    return server;
  }

  private saveCache(): void {
    const p = this.state.profile;
    if (!p) return;
    const profile = { ...p, cache: { friends: this.state.friends, conversations: this.state.conversations } };
    this.state.profile = profile;
    window.native.saveProfile(profile);
  }

  async saveSettings(patch: NonNullable<Profile['settings']>): Promise<void> {
    const p = this.state.profile;
    if (!p) return;
    const profile = { ...p, settings: { ...p.settings, ...patch } };
    await window.native.saveProfile(profile);
    this.set({ profile });
  }

  notify(title: string, body: string, force = false): void {
    if (!force && this.myStatus().availability === 'dnd') return; // não perturbe
    if (window.native.notify) {
      // Celular: com o app aberto na frente, a própria tela já mostra.
      if (document.hidden) window.native.notify(title, body);
      return;
    }
    window.native.flash();
    if (document.hasFocus()) return;
    try {
      new Notification(title, { body, silent: false });
    } catch {
      /* notificações indisponíveis */
    }
  }

  // ---- conversas / mensagens ----

  /** null volta para a lista (no celular a conversa ocupa a tela toda). */
  async select(conversationId: string | null): Promise<void> {
    if (!conversationId) return this.set({ selected: null });
    const unread = { ...this.state.unread };
    delete unread[conversationId];
    this.set({ selected: conversationId, unread, tabs: this.withTab(conversationId) });
    if (!this.state.messages[conversationId]) {
      const msgs = await window.native.loadMessages(conversationId);
      this.set({ messages: { ...this.state.messages, [conversationId]: msgs } });
    }
  }

  /** Mensagem recebida: primeiro grava no disco, depois confirma ao servidor. */
  private async receive(message: Message): Promise<void> {
    const fresh = await window.native.appendMessages(message.conversation_id, [message]);
    this.queueAck(message.id);
    if (!fresh.length) return;
    if (message.attachment?.kind === 'file') autoDownload(message.conversation_id, message.attachment);
    if (message.attachment?.kind === 'reminder') scheduleReminder(message);
    this.addToState(message);
    if (isMutation(message)) return; // edição/apagar/reação: sem notificação nem não lida
    if (message.sender_id !== this.me()?.id && (this.state.selected !== message.conversation_id || !document.hasFocus())) {
      if (this.state.selected !== message.conversation_id) {
        const unread = { ...this.state.unread, [message.conversation_id]: (this.state.unread[message.conversation_id] ?? 0) + 1 };
        this.set({ unread });
      }
      const conv = this.state.conversations.find((c) => c.id === message.conversation_id);
      const sender = this.user(message.sender_id)?.display_name ?? 'Alguém';
      const title = conv?.type !== 'DIRECT' && conv ? `${sender} em ${this.conversationTitle(conv)}` : sender;
      // Conversa silenciada só avisa se me mencionaram.
      const mentioned = this.mentionsMe(message.content);
      if (!this.isMuted(message.conversation_id) || mentioned) this.notify(mentioned ? `${title} mencionou você` : title, message.content.slice(0, 140));
    }
    // Para de mostrar "digitando" de quem acabou de mandar.
    const t = this.state.typing[message.conversation_id];
    if (t?.[message.sender_id]) {
      const conv = { ...t };
      delete conv[message.sender_id];
      this.set({ typing: { ...this.state.typing, [message.conversation_id]: conv } });
    }
  }

  private addToState(message: Message): void {
    const list = this.state.messages[message.conversation_id];
    if (!list) return; // conversa ainda não aberta: carrega do disco quando abrir
    if (list.some((m) => m.id === message.id)) return;
    const next = [...list, message].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    this.set({ messages: { ...this.state.messages, [message.conversation_id]: next } });
  }

  private queueAck(id: string): void {
    this.pendingAcks.push(id);
    clearTimeout(this.ackTimer);
    this.ackTimer = window.setTimeout(() => {
      const ids = this.pendingAcks.splice(0);
      this.gw?.request('mailbox.ack', { ids }).catch(() => {
        // Sem conexão: o servidor reentrega depois e o dedupe local descarta.
      });
    }, 300);
  }

  async send(conversationId: string, text: string, replyTo?: string): Promise<void> {
    const content = text.trim();
    if (!content) return;
    if (content.length > MAX_MESSAGE_LENGTH) return this.toast(`Mensagem longa demais (máx. ${MAX_MESSAGE_LENGTH})`);
    return this.enqueue(conversationId, content, replyTo ? { reply_to: replyTo } : {});
  }

  async editMessage(conversationId: string, id: string, text: string): Promise<void> {
    const content = text.trim();
    if (!content) return this.deleteMessage(conversationId, id);
    if (content.length > MAX_MESSAGE_LENGTH) return this.toast(`Mensagem longa demais (máx. ${MAX_MESSAGE_LENGTH})`);
    return this.enqueue(conversationId, content, { edit_of: id });
  }

  async deleteMessage(conversationId: string, id: string): Promise<void> {
    return this.enqueue(conversationId, '🗑 (apagou uma mensagem)', { delete_of: id });
  }

  async react(conversationId: string, target: string, emoji: string, on: boolean): Promise<void> {
    return this.enqueue(conversationId, `${on ? 'reagiu' : 'tirou a reação'} ${emoji}`, { reaction: { target, emoji, on } });
  }

  async vote(conversationId: string, target: string, options: number[]): Promise<void> {
    return this.enqueue(conversationId, options.length ? '🗳 votou na enquete' : '🗳 tirou o voto', { vote: { target, options } });
  }

  async sendPoll(conversationId: string, poll: PollAttachment): Promise<void> {
    return this.sendAttachment(conversationId, `📊 Enquete: ${poll.question}\n${poll.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`, poll);
  }

  async sendReminder(conversationId: string, at: number, text: string): Promise<void> {
    const when = new Date(at).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return this.sendAttachment(conversationId, `⏰ Lembrete para ${when}: ${text}`, { kind: 'reminder', at, text });
  }

  /** Toda mensagem (texto, anexo, mudança) entra na fila local e sai em ordem quando há conexão. */
  private async enqueue(conversationId: string, content: string, extra: Partial<Message>): Promise<void> {
    const me = this.me();
    if (!me) return;
    const msg: Message = { id: ulid(), conversation_id: conversationId, sender_id: me.id, content, created_at: Date.now(), ...extra };
    const outbox = [...this.state.outbox, msg];
    this.set({ outbox });
    await window.native.saveOutbox(outbox);
    this.flushOutbox();
  }

  async sendVoice(conversationId: string, attachment: VoiceAttachment): Promise<void> {
    const secs = Math.round(attachment.duration_ms / 1000);
    const content = `🎤 Mensagem de voz (${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')})`;
    return this.sendAttachment(conversationId, content, attachment);
  }

  /** Arquivo já enviado ao host (POST /files): vira mensagem. */
  async sendFile(conversationId: string, attachment: FileAttachment): Promise<void> {
    return this.sendAttachment(conversationId, `📎 ${attachment.name} (${formatSize(attachment.size)})`, attachment);
  }

  private async sendAttachment(conversationId: string, content: string, attachment: Attachment): Promise<void> {
    return this.enqueue(conversationId, content, { attachment });
  }

  /** Envia a fila em ordem. Para no primeiro erro de rede; tenta de novo ao reconectar. */
  private async flushOutbox(): Promise<void> {
    if (this.flushing || !this.gw) return;
    this.flushing = true;
    try {
      while (this.state.outbox.length && this.gw.status === 'online') {
        const msg = this.state.outbox[0];
        try {
          const { message } = await this.gw.request('message.send', {
            id: msg.id,
            conversation_id: msg.conversation_id,
            content: msg.content,
            ...(msg.attachment && { attachment: msg.attachment }),
            ...(msg.reply_to && { reply_to: msg.reply_to }),
            ...(msg.edit_of && { edit_of: msg.edit_of }),
            ...(msg.delete_of && { delete_of: msg.delete_of }),
            ...(msg.reaction && { reaction: msg.reaction }),
            ...(msg.vote && { vote: msg.vote }),
          });
          await window.native.appendMessages(message.conversation_id, [message]);
          this.addToState(message);
        } catch (e) {
          if (this.gw.status !== 'online' || (e as Error).message === 'servidor não respondeu') break;
          // Recusada pelo servidor (ex.: não é mais membro): descarta para não travar a fila.
          this.toast(`Mensagem não enviada: ${(e as Error).message}`);
        }
        const outbox = this.state.outbox.filter((m) => m.id !== msg.id);
        this.set({ outbox });
        await window.native.saveOutbox(outbox);
      }
    } finally {
      this.flushing = false;
    }
  }

  typing(conversationId: string): void {
    if (Date.now() - this.lastTypingSent < 3000) return;
    this.lastTypingSent = Date.now();
    this.gw?.emit('typing', { conversation_id: conversationId });
  }

  typingUsers(conversationId: string): UserPublic[] {
    const now = Date.now();
    return Object.entries(this.state.typing[conversationId] ?? {})
      .filter(([, until]) => until > now)
      .map(([id]) => this.user(id))
      .filter((u): u is UserPublic => !!u);
  }

  // ---- amigos / grupos ----

  private requireOnline(): GatewayClient {
    if (!this.gw || this.gw.status !== 'online') throw new Error('Sem conexão com o servidor');
    return this.gw;
  }

  async addFriend(username: string): Promise<void> {
    await this.requireOnline().request('friend.request', { username });
  }

  async acceptFriend(userId: string): Promise<void> {
    await this.requireOnline().request('friend.accept', { user_id: userId });
  }

  async removeFriend(userId: string): Promise<void> {
    await this.requireOnline().request('friend.remove', { user_id: userId });
  }

  async createGroup(name: string, memberIds: string[]): Promise<void> {
    const { conversation } = await this.requireOnline().request('group.create', { name, member_ids: memberIds });
    this.select(conversation.id);
  }

  async createInvite(): Promise<string> {
    const { code } = await this.requireOnline().request('invite.create', {});
    return code;
  }

  // ---- calls ----

  async joinCall(conversationId: string): Promise<void> {
    if (this.state.call?.conversationId === conversationId) return;
    const gw = this.requireOnline();
    this.leaveCall();
    const session = new CallSession(gw, conversationId, this.state.connectionId!);
    session.onChange = () => this.bump();
    session.onScreenEnded = () => this.pushCallState();
    this.set({ call: session, ringing: null, callError: null });
    const s = this.state.profile?.settings;
    const micError = await session.start({
      micId: s?.mic_id,
      speakerId: s?.speaker_id,
      mic: micSettings(s),
      playback: this.state.platform === 'android' ? 'element' : 'webaudio',
      volumeOf: (userId, kind) => this.userVolume(userId, kind),
      iceServers: () => this.iceServers(),
    });
    // Depois do microfone: o Android só deixa o serviço usar o mic se a permissão já foi dada.
    window.native.callActive?.(true);
    if (micError) {
      const msg = `${micErrorMessage(micError, this.state.platform)} Você entrou só para ouvir.`;
      this.set({ callError: msg });
      this.toast(msg);
    }
    await gw.request('call.join', { conversation_id: conversationId });
    // Os outros veem que estou mutado (sem microfone).
    if (session.noMic) this.pushCallState();
    if (window.native.setSpeaker) this.setSpeaker(this.state.speaker);
    // Se o call.update chegou antes do microfone ficar pronto, sincroniza agora.
    const info = this.state.calls[conversationId];
    if (info) session.sync(info);
    await this.applyHotkeys();
  }

  // ---- atalhos e push-to-talk ----

  private pttDown = false;
  private hotkeysInstalled = false;

  /** Registra os atalhos globais (só enquanto estou numa call). No modo push-to-talk entra mutado. */
  async applyHotkeys(): Promise<void> {
    const s = this.state.profile?.settings;
    const call = this.state.call;
    this.installHotkeyListeners();
    if (!call) {
      await window.native.hotkeysClear?.();
      return;
    }
    const ptt = s?.voice_mode === 'ptt';
    if (ptt && !call.noMic && !this.pttDown && !call.muted) {
      call.setMuted(true);
      this.pushCallState();
    }
    const failed =
      (await window.native.hotkeysSet?.({
        mute: hotkeyOf(s, 'mute'),
        deafen: hotkeyOf(s, 'deafen'),
        ...(window.native.recStart && { clip: hotkeyOf(s, 'clip') }),
        ...(ptt && { ptt: hotkeyOf(s, 'ptt') }),
      })) ?? [];
    const kind = await window.native.hotkeysKind?.();
    const real = failed.filter((n) => !(n === 'ptt' && kind === 'basic')); // no Windows o ptt é só com o app em foco, já avisado
    if (real.length) this.toast(`Atalho não registrado (já usado por outro app?): ${real.join(', ')}`);
  }

  private installHotkeyListeners(): void {
    if (this.hotkeysInstalled) return;
    this.hotkeysInstalled = true;
    window.native.onHotkey?.(({ name, pressed }) => {
      if (!this.state.call) return;
      if (name === 'ptt') this.setPtt(pressed);
      else if (pressed && name === 'mute') this.toggleMute();
      else if (pressed && name === 'deafen') this.toggleDeafen();
      else if (pressed && name === 'clip') saveClip().catch((e) => this.toast((e as Error).message));
    });
    // Push-to-talk com o app em foco (vale em qualquer sistema; no KDE também é global).
    const isPtt = (e: KeyboardEvent) => {
      const s = this.state.profile?.settings;
      const key = hotkeyOf(s, 'ptt');
      if (s?.voice_mode !== 'ptt' || !key || !this.state.call) return false;
      if ((e.target as HTMLElement)?.closest?.('textarea, input, [contenteditable]') && !/\+/.test(key) && key.length === 1) return false; // tecla de letra solta: deixa digitar
      return e.type === 'keyup' ? mainKey(accelFromEvent(e) ?? '') === mainKey(key) : accelFromEvent(e) === key;
    };
    window.addEventListener('keydown', (e) => {
      if (!e.repeat && isPtt(e)) this.setPtt(true);
    });
    window.addEventListener('keyup', (e) => {
      if (isPtt(e)) this.setPtt(false);
    });
    // Perdeu o foco segurando a tecla: não deixa o microfone aberto (o global do KDE continua valendo).
    window.addEventListener('blur', () => {
      if (this.pttDown && window.native.hotkeysKind) window.native.hotkeysKind().then((k) => k === 'basic' && this.setPtt(false));
    });
  }

  setPtt(down: boolean): void {
    const call = this.state.call;
    if (!call || call.noMic || this.pttDown === down) return;
    if (this.state.profile?.settings?.voice_mode !== 'ptt') return;
    this.pttDown = down;
    if (down && call.deafened) return;
    call.setMuted(!down);
    this.pushCallState();
  }

  get pttActive(): boolean {
    return this.pttDown;
  }

  leaveCall(notify = true): void {
    const s = this.state.call;
    if (!s) return;
    stopAllRecording();
    s.close();
    this.pttDown = false;
    window.native.hotkeysClear?.();
    window.native.callActive?.(false);
    if (notify) this.gw?.emit('call.leave', { conversation_id: s.conversationId });
    this.set({ call: null, stage: 'normal' });
  }

  setSpeaker(on: boolean): void {
    this.set({ speaker: on });
    window.native.setSpeaker?.(on).catch((e) => this.toast(errorMessage(e)));
  }

  declineCall(): void {
    this.set({ ringing: null });
  }

  private pushCallState(): void {
    const s = this.state.call;
    if (!s) return;
    this.gw?.emit('call.state', {
      conversation_id: s.conversationId,
      muted: s.muted,
      deafened: s.deafened,
      screen_sharing: !!s.screen,
      recording: isRecording(),
    });
    this.bump();
  }

  toggleMute(): void {
    const s = this.state.call;
    if (!s) return;
    if (s.deafened) s.setDeafened(false);
    s.setMuted(!s.muted);
    this.pushCallState();
  }

  toggleDeafen(): void {
    const s = this.state.call;
    if (!s) return;
    s.setDeafened(!s.deafened);
    this.pushCallState();
  }

  /** Volume (1 = 100%) que eu escolhi para a voz ou a transmissão dessa pessoa. */
  userVolume(userId: string, kind: AudioKind): number {
    return this.state.profile?.settings?.user_volumes?.[userId]?.[kind] ?? 1;
  }

  /** Aplica na hora; salva no disco um pouco depois (o slider dispara muitas vezes). */
  setUserVolume(userId: string, kind: AudioKind, volume: number): void {
    const p = this.state.profile;
    if (!p) return;
    const all = { ...p.settings?.user_volumes };
    all[userId] = { ...all[userId], [kind]: volume };
    this.state.profile = { ...p, settings: { ...p.settings, user_volumes: all } };
    this.state.call?.refreshVolumes();
    this.bump();
    clearTimeout(this.volumeSaveTimer);
    this.volumeSaveTimer = window.setTimeout(() => this.state.profile && window.native.saveProfile(this.state.profile), 400);
  }
  private volumeSaveTimer = 0;

  /** Volume/sensibilidade/supressão de ruído do meu microfone: vale na hora, inclusive dentro da call. */
  async saveMicSettings(patch: Pick<Settings, 'mic_volume' | 'mic_threshold' | 'mic_noise' | 'mic_level'>): Promise<void> {
    await this.saveSettings(patch);
    this.state.call?.setMicSettings(micSettings(this.state.profile?.settings));
  }

  async toggleCamera(): Promise<void> {
    const s = this.state.call;
    if (!s) return;
    if (s.camera) {
      s.stopCamera();
      return this.bump();
    }
    try {
      await s.startCamera(this.state.profile?.settings?.camera_id);
    } catch (e) {
      const err = e as Error;
      this.toast(
        err.name === 'NotAllowedError'
          ? 'Sem permissão para usar a câmera.'
          : err.name === 'NotFoundError'
            ? 'Nenhuma câmera encontrada.'
            : err.name === 'NotReadableError'
              ? 'A câmera está ocupada por outro programa.'
              : `Não consegui abrir a câmera: ${err.message}`,
      );
    }
    this.bump();
  }

  async startScreen(preset: ScreenPreset, withAudio: boolean, hint: 'detail' | 'motion', audioApps?: string[]): Promise<void> {
    const s = this.state.call;
    if (!s) return;
    try {
      await s.startScreen(preset, withAudio, hint, audioApps, !!this.state.profile?.settings?.share_include_voice_apps);
      this.saveSettings({ screen_preset: preset });
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') this.toast(`Não consegui capturar a tela: ${(e as Error).message}`);
      return;
    }
    this.pushCallState();
  }

  /** Comando pro bot de YouTube da call em que estou. */
  async media(action: MediaAction): Promise<void> {
    const call = this.state.call;
    if (!call) throw new Error('Entre numa call para usar o bot');
    await this.requireOnline().request('call.media', { conversation_id: call.conversationId, action });
  }

  /** Gravação começou/parou: os outros veem o aviso. */
  recordingChanged(): void {
    this.pushCallState();
  }

  async startVideoShare(file: File, preset: ScreenPreset): Promise<void> {
    try {
      await startVideoFile(file, preset);
      this.saveSettings({ screen_preset: preset });
    } catch (e) {
      this.toast((e as Error).message);
      return;
    }
    this.pushCallState();
  }

  stopScreen(): void {
    this.state.call?.stopScreen();
    this.pushCallState();
  }
}

export const app = new App();

export function useApp<T>(select: (s: State) => T): T {
  return useSyncExternalStore(app.subscribe, () => select(app.state));
}
