import type { WebSocket } from 'ws';
import type {
  ClientOps,
  Conversation,
  Message,
  ServerOps,
  UserPublic,
} from '../../shared/protocol.ts';
import { MAX_MESSAGE_LENGTH } from '../../shared/protocol.ts';
import type { Db } from './db.ts';
import { Calls } from './calls.ts';
import { hashToken } from './auth.ts';
import { randomCode, ulid, ULID_RE } from './ids.ts';

const HEARTBEAT_TIMEOUT_MS = 45_000;
const HELLO_TIMEOUT_MS = 10_000;
const RING_TIMEOUT_MS = 45_000;
const MAX_FRAME_BYTES = 256 * 1024;

class ClientError extends Error {}

type Conn = {
  id: string;
  ws: WebSocket;
  user?: UserPublic;
  lastSeen: number;
};

type Handler<K extends keyof ClientOps> = (conn: Conn & { user: UserPublic }, d: ClientOps[K]) => unknown;

export class Gateway {
  private conns = new Map<string, Conn>();
  private byUser = new Map<string, Set<string>>();
  private calls = new Calls();
  private db: Db;

  private reapTimer: NodeJS.Timeout;

  constructor(db: Db) {
    this.db = db;
    this.reapTimer = setInterval(() => this.reapDead(), 10_000);
    this.reapTimer.unref();
  }

  private stopping = false;

  /** Encerra todas as conexões (host desligando a sessão). Depois disso não toca mais no banco. */
  shutdown(): void {
    this.stopping = true;
    clearInterval(this.reapTimer);
    for (const c of this.conns.values()) c.ws.close(1001, 'servidor desligando');
    this.conns.clear();
    this.byUser.clear();
  }

  attach(ws: WebSocket): void {
    const conn: Conn = { id: ulid(), ws, lastSeen: Date.now() };
    this.conns.set(conn.id, conn);
    const helloTimer = setTimeout(() => !conn.user && ws.close(4001, 'hello timeout'), HELLO_TIMEOUT_MS);

    ws.on('message', (raw, isBinary) => {
      if (this.stopping) return;
      conn.lastSeen = Date.now();
      if (isBinary || (raw as Buffer).length > MAX_FRAME_BYTES) return ws.close(4002, 'frame inválido');
      let env: { op?: string; d?: unknown; rid?: string };
      try {
        env = JSON.parse(raw.toString());
      } catch {
        return ws.close(4002, 'json inválido');
      }
      this.handle(conn, env).catch((e) => {
        const error = e instanceof ClientError ? e.message : 'erro interno';
        if (!(e instanceof ClientError)) console.error('[gateway]', env.op, e);
        if (env.rid) this.send(conn, 'ack', { ok: false, error }, env.rid);
      });
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.detach(conn);
    });
    ws.on('error', () => ws.close());
  }

  // ---- envio ----

  private send<K extends keyof ServerOps>(conn: Conn, op: K, d: ServerOps[K], rid?: string): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(JSON.stringify(rid ? { op, d, rid } : { op, d }));
  }

  private sendToUser<K extends keyof ServerOps>(userId: string, op: K, d: ServerOps[K]): void {
    for (const cid of this.byUser.get(userId) ?? []) {
      const c = this.conns.get(cid);
      if (c) this.send(c, op, d);
    }
  }

  private sendToMembers<K extends keyof ServerOps>(conversationId: string, op: K, d: ServerOps[K]): void {
    for (const uid of this.db.memberIds(conversationId)) this.sendToUser(uid, op, d);
  }

  private isOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  // ---- ciclo de vida ----

  private async handle(conn: Conn, env: { op?: string; d?: unknown; rid?: string }): Promise<void> {
    const d = (env.d ?? {}) as Record<string, unknown>;
    if (env.op === 'hello') return this.hello(conn, d as ClientOps['hello']);
    if (!conn.user) throw new ClientError('não autenticado');
    if (env.op === 'ping') return this.send(conn, 'pong', {});

    const handler = (this.handlers as Record<string, Handler<keyof ClientOps>>)[env.op ?? ''];
    if (!handler) throw new ClientError(`op desconhecida: ${env.op}`);
    const result = await handler(conn as Conn & { user: UserPublic }, d as never);
    if (env.rid) this.send(conn, 'ack', { ok: true, d: result ?? undefined }, env.rid);
  }

  private hello(conn: Conn, d: ClientOps['hello']): void {
    if (conn.user) return;
    const user = typeof d.token === 'string' ? this.db.userBySession(hashToken(d.token)) : undefined;
    if (!user) {
      conn.ws.close(4003, 'token inválido');
      return;
    }
    conn.user = user;
    const wasOnline = this.isOnline(user.id);
    if (!this.byUser.has(user.id)) this.byUser.set(user.id, new Set());
    this.byUser.get(user.id)!.add(conn.id);

    const friends = this.db.friendsOf(user.id);
    const presences: Record<string, 'ONLINE' | 'OFFLINE'> = {};
    for (const f of friends) presences[f.user.id] = this.isOnline(f.user.id) ? 'ONLINE' : 'OFFLINE';
    const conversations = this.db.conversationsOf(user.id);
    const convIds = new Set(conversations.map((c) => c.id));

    this.send(conn, 'ready', {
      connection_id: conn.id,
      user,
      friends,
      conversations,
      presences,
      calls: this.calls.all().filter((c) => convIds.has(c.conversation_id)),
    });
    // Entrega o que ficou na caixa de correio enquanto estava offline.
    for (const message of this.db.mailboxFor(user.id)) this.send(conn, 'message.created', { message });

    if (!wasOnline) this.broadcastPresence(user.id, 'ONLINE');
    console.log(`[gateway] ${user.username} conectou (${conn.id})`);
  }

  private detach(conn: Conn): void {
    // Desligando: o banco pode já estar fechado, e ninguém mais recebe presença.
    if (this.stopping) return;
    this.conns.delete(conn.id);
    if (!conn.user) return;
    const set = this.byUser.get(conn.user.id);
    set?.delete(conn.id);
    for (const convId of this.calls.callsOfConnection(conn.id)) this.leaveCall(convId, conn.id);
    if (!set?.size) {
      this.byUser.delete(conn.user.id);
      this.broadcastPresence(conn.user.id, 'OFFLINE');
    }
    console.log(`[gateway] ${conn.user.username} desconectou (${conn.id})`);
  }

  private reapDead(): void {
    const now = Date.now();
    for (const c of this.conns.values()) {
      if (now - c.lastSeen > HEARTBEAT_TIMEOUT_MS) c.ws.terminate();
    }
  }

  private broadcastPresence(userId: string, status: 'ONLINE' | 'OFFLINE'): void {
    for (const fid of this.db.acceptedFriendIds(userId)) this.sendToUser(fid, 'presence.update', { user_id: userId, status });
  }

  private syncFriends(...userIds: string[]): void {
    for (const uid of userIds) this.sendToUser(uid, 'friends.sync', { friends: this.db.friendsOf(uid) });
  }

  private upsertConversation(conv: Conversation): void {
    this.sendToMembers(conv.id, 'conversation.upsert', { conversation: conv });
  }

  // ---- calls ----

  private leaveCall(conversationId: string, connectionId: string): void {
    const r = this.calls.leave(conversationId, connectionId);
    if (!r) return;
    if (r.ended) this.sendToMembers(conversationId, 'call.ended', { conversation_id: conversationId, duration_s: r.duration_s });
    else this.sendToMembers(conversationId, 'call.update', { call: this.calls.info(conversationId)! });
  }

  private requireMember(conversationId: unknown, userId: string): string {
    if (typeof conversationId !== 'string' || !this.db.isMember(conversationId, userId)) {
      throw new ClientError('conversa não encontrada');
    }
    return conversationId;
  }

  // ---- comandos ----

  private handlers: { [K in keyof ClientOps]?: Handler<K> } = {
    'invite.create': (conn, d) => {
      // Convite de uso múltiplo (vai embutido no instalador exportado): só o admin/host.
      const multi = !!d?.multi_use;
      if (multi && !this.db.isAdmin(conn.user.id)) throw new ClientError('só o host pode criar esse convite');
      const code = randomCode(multi ? 16 : 8);
      this.db.createInvite(code, conn.user.id, multi ? null : 1);
      return { code };
    },

    'friend.request': (conn, d) => {
      const target = typeof d.username === 'string' ? this.db.userByUsername(d.username.trim()) : undefined;
      if (!target) throw new ClientError('usuário não encontrado');
      if (target.id === conn.user.id) throw new ClientError('não dá pra adicionar você mesmo');
      const existing = this.db.friendship(conn.user.id, target.id);
      if (existing?.status === 'ACCEPTED') throw new ClientError('vocês já são amigos');
      if (existing && existing.requested_by !== conn.user.id) {
        // O outro já tinha pedido: aceitar direto.
        return this.handlers['friend.accept']!(conn, { user_id: target.id });
      }
      if (!existing) this.db.requestFriend(conn.user.id, target.id);
      this.syncFriends(conn.user.id, target.id);
    },

    'friend.accept': (conn, d) => {
      const f = typeof d.user_id === 'string' ? this.db.friendship(conn.user.id, d.user_id) : undefined;
      if (!f || f.status !== 'PENDING' || f.requested_by === conn.user.id) throw new ClientError('pedido não encontrado');
      const conv = this.db.tx(() => {
        this.db.acceptFriend(conn.user.id, d.user_id);
        return this.db.ensureDirect(conn.user.id, d.user_id);
      });
      this.syncFriends(conn.user.id, d.user_id);
      this.upsertConversation(conv);
      // Presença mútua agora que são amigos.
      this.sendToUser(conn.user.id, 'presence.update', {
        user_id: d.user_id,
        status: this.isOnline(d.user_id) ? 'ONLINE' : 'OFFLINE',
      });
      this.sendToUser(d.user_id, 'presence.update', { user_id: conn.user.id, status: 'ONLINE' });
    },

    'friend.remove': (conn, d) => {
      if (typeof d.user_id !== 'string' || !this.db.friendship(conn.user.id, d.user_id)) {
        throw new ClientError('amizade não encontrada');
      }
      // A conversa DIRECT e o histórico local continuam; só some da lista de amigos.
      this.db.removeFriend(conn.user.id, d.user_id);
      this.syncFriends(conn.user.id, d.user_id);
    },

    'group.create': (conn, d) => {
      const name = typeof d.name === 'string' ? d.name.trim() : '';
      if (!name || name.length > 64) throw new ClientError('nome do grupo inválido');
      const friends = new Set(this.db.acceptedFriendIds(conn.user.id));
      const members = Array.isArray(d.member_ids) ? d.member_ids.filter((id) => friends.has(id)) : [];
      if (!members.length) throw new ClientError('escolha pelo menos um amigo');
      const conversation = this.db.tx(() => this.db.createGroup(conn.user.id, name, members));
      this.upsertConversation(conversation);
      return { conversation };
    },

    'message.send': (conn, d) => {
      const conversationId = this.requireMember(d.conversation_id, conn.user.id);
      if (typeof d.id !== 'string' || !ULID_RE.test(d.id)) throw new ClientError('id de mensagem inválido');
      const content = typeof d.content === 'string' ? d.content.trim() : '';
      if (!content || content.length > MAX_MESSAGE_LENGTH) throw new ClientError('mensagem vazia ou longa demais');

      // Reenvio (ack anterior se perdeu): devolve o carimbo original sem duplicar.
      const prev = this.db.existingMessage(d.id);
      if (prev) {
        if (prev.sender_id !== conn.user.id) throw new ClientError('id de mensagem em uso');
        return { message: { id: d.id, conversation_id: prev.conversation_id, sender_id: prev.sender_id, content, created_at: prev.created_at } };
      }

      const message: Message = { id: d.id, conversation_id: conversationId, sender_id: conn.user.id, content, created_at: Date.now() };
      const recipients = this.db.memberIds(conversationId).filter((u) => u !== conn.user.id);
      this.db.tx(() => this.db.storeMessage(message, recipients));
      for (const uid of recipients) this.sendToUser(uid, 'message.created', { message });
      return { message };
    },

    'mailbox.ack': (conn, d) => {
      if (!Array.isArray(d.ids)) throw new ClientError('ids inválidos');
      this.db.tx(() => this.db.ackMailbox(conn.user.id, d.ids.filter((x) => typeof x === 'string').slice(0, 1000)));
    },

    typing: (conn, d) => {
      const conversationId = this.requireMember(d.conversation_id, conn.user.id);
      for (const uid of this.db.memberIds(conversationId)) {
        if (uid !== conn.user.id) this.sendToUser(uid, 'typing', { conversation_id: conversationId, user_id: conn.user.id });
      }
    },

    'call.join': (conn, d) => {
      const conversationId = this.requireMember(d.conversation_id, conn.user.id);
      const { created, replaced } = this.calls.join(conversationId, conn.user.id, conn.id);
      for (const old of replaced) {
        const c = this.conns.get(old);
        if (c) this.send(c, 'call.ended', { conversation_id: conversationId, duration_s: 0 });
      }
      if (created) {
        for (const uid of this.db.memberIds(conversationId)) {
          if (uid !== conn.user.id) this.sendToUser(uid, 'call.ringing', { conversation_id: conversationId, from_user_id: conn.user.id });
        }
        this.calls.setRingTimer(conversationId, RING_TIMEOUT_MS, () => {
          const duration_s = this.calls.end(conversationId);
          this.sendToMembers(conversationId, 'call.ended', { conversation_id: conversationId, duration_s });
        });
      }
      this.sendToMembers(conversationId, 'call.update', { call: this.calls.info(conversationId)! });
    },

    'call.leave': (conn, d) => {
      const conversationId = this.requireMember(d.conversation_id, conn.user.id);
      this.leaveCall(conversationId, conn.id);
    },

    'call.state': (conn, d) => {
      const conversationId = this.requireMember(d.conversation_id, conn.user.id);
      if (!this.calls.setState(conversationId, conn.id, d)) throw new ClientError('você não está nessa call');
      this.sendToMembers(conversationId, 'call.update', { call: this.calls.info(conversationId)! });
    },

    'rtc.signal': (conn, d) => {
      const conversationId = this.requireMember(d.conversation_id, conn.user.id);
      if (!this.calls.inCall(conversationId, conn.id) || !this.calls.inCall(conversationId, d.to_connection_id)) {
        throw new ClientError('peer fora da call');
      }
      const target = this.conns.get(d.to_connection_id);
      if (target) {
        this.send(target, 'rtc.signal', {
          conversation_id: conversationId,
          from_connection_id: conn.id,
          from_user_id: conn.user.id,
          signal: d.signal,
        });
      }
    },
  };
}
