import { useSyncExternalStore } from 'react';
import type {
  CallInfo,
  Conversation,
  Friend,
  Message,
  Presence,
  UserPublic,
} from '../../shared/protocol.ts';
import { MAX_MESSAGE_LENGTH } from '../../shared/protocol.ts';
import { GatewayClient, httpPost } from './gateway.ts';
import { CallSession, type ScreenPreset } from './rtc.ts';
import { ulid } from './ulid.ts';
import type { EmbeddedConfig, HostConfig, HostStatus, Profile, UpdateStatus } from './native.d.ts';

/** Erros vindos do processo principal chegam com prefixo do Electron. */
export function errorMessage(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Traduz o erro do getUserMedia para algo que dá pra resolver. */
function micErrorMessage(e: Error): string {
  switch (e.name) {
    case 'NotAllowedError':
      return 'Sem permissão para usar o microfone. No Windows: Configurações → Privacidade → Microfone → permitir apps da área de trabalho.';
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
};

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
    if (c.type === 'GROUP') return c.name ?? 'Grupo';
    const other = c.members.find((m) => m.id !== this.me()?.id);
    return other?.display_name ?? 'Conversa';
  }

  directPeer(c: Conversation): UserPublic | undefined {
    return c.type === 'DIRECT' ? c.members.find((m) => m.id !== this.me()?.id) : undefined;
  }

  // ---- boot / login ----

  async boot(): Promise<void> {
    const [stored, outbox, info, embedded, host, update] = await Promise.all([
      window.native.loadProfile(),
      window.native.loadOutbox(),
      window.native.info(),
      window.native.embedded(),
      window.native.hostStatus(),
      window.native.updateStatus(),
    ]);
    window.native.onUpdateStatus((u) => this.set({ update: u }));
    const profile = stored && { ...stored, role: stored.role ?? 'client' };
    // Offline-first: mostra o que está no cache antes de qualquer rede.
    this.set({
      booted: true,
      profile,
      outbox,
      platform: info.platform,
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
      device_name: `desktop-${this.state.platform}`,
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
      });
      this.saveCache();
      this.flushOutbox();
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

  reconnectNow(): void {
    this.gw?.reconnectNow();
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

  private notify(title: string, body: string): void {
    window.native.flash();
    if (document.hasFocus()) return;
    try {
      new Notification(title, { body, silent: false });
    } catch {
      /* notificações indisponíveis */
    }
  }

  // ---- conversas / mensagens ----

  async select(conversationId: string): Promise<void> {
    const unread = { ...this.state.unread };
    delete unread[conversationId];
    this.set({ selected: conversationId, unread });
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
    this.addToState(message);
    if (message.sender_id !== this.me()?.id && (this.state.selected !== message.conversation_id || !document.hasFocus())) {
      if (this.state.selected !== message.conversation_id) {
        const unread = { ...this.state.unread, [message.conversation_id]: (this.state.unread[message.conversation_id] ?? 0) + 1 };
        this.set({ unread });
      }
      const conv = this.state.conversations.find((c) => c.id === message.conversation_id);
      const sender = this.user(message.sender_id)?.display_name ?? 'Alguém';
      const title = conv?.type === 'GROUP' ? `${sender} em ${this.conversationTitle(conv)}` : sender;
      this.notify(title, message.content.slice(0, 140));
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

  async send(conversationId: string, text: string): Promise<void> {
    const content = text.trim();
    const me = this.me();
    if (!content || !me) return;
    if (content.length > MAX_MESSAGE_LENGTH) return this.toast(`Mensagem longa demais (máx. ${MAX_MESSAGE_LENGTH})`);
    const msg: Message = { id: ulid(), conversation_id: conversationId, sender_id: me.id, content, created_at: Date.now() };
    const outbox = [...this.state.outbox, msg];
    this.set({ outbox });
    await window.native.saveOutbox(outbox);
    this.flushOutbox();
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
    try {
      const s = this.state.profile?.settings;
      await session.start(s?.mic_id, s?.speaker_id);
    } catch (e) {
      session.close();
      const msg = micErrorMessage(e as Error);
      this.set({ call: null, callError: msg });
      // O painel da call some junto quando ninguém mais está nela; o toast garante que o erro apareça.
      this.toast(msg);
      return;
    }
    await gw.request('call.join', { conversation_id: conversationId });
    // Se o call.update chegou antes do microfone ficar pronto, sincroniza agora.
    const info = this.state.calls[conversationId];
    if (info) session.sync(info);
  }

  leaveCall(notify = true): void {
    const s = this.state.call;
    if (!s) return;
    s.close();
    if (notify) this.gw?.emit('call.leave', { conversation_id: s.conversationId });
    this.set({ call: null, stage: 'normal' });
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

  async startScreen(preset: ScreenPreset, withAudio: boolean, hint: 'detail' | 'motion'): Promise<void> {
    const s = this.state.call;
    if (!s) return;
    try {
      await s.startScreen(preset, withAudio, hint);
      this.saveSettings({ screen_preset: preset });
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') this.toast(`Não consegui capturar a tela: ${(e as Error).message}`);
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
