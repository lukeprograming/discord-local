import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Conversation, Friend, FriendStatus, Message, Sound, UserPublic, UserStatus } from '../../shared/protocol.ts';
import { ulid } from './ids.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  device_name  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  used_by    TEXT REFERENCES users(id),  -- último usuário que usou
  created_at INTEGER NOT NULL,
  used_at    INTEGER,
  max_uses   INTEGER DEFAULT 1,          -- NULL = ilimitado (convite embutido no instalador)
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked    INTEGER NOT NULL DEFAULT 0
);
-- Um registro por par, sempre (menor id, maior id).
CREATE TABLE IF NOT EXISTS friendships (
  user_low     TEXT NOT NULL,
  user_high    TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL,            -- PENDING | ACCEPTED
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_low, user_high)
);
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,              -- DIRECT | GROUP | ROOM
  name       TEXT,
  owner_id   TEXT,
  direct_key TEXT UNIQUE,                -- "low:high" nas DIRECT
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  joined_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
-- Só id + carimbo: serve para o reenvio idempotente. O conteúdo não fica aqui.
CREATE TABLE IF NOT EXISTS message_ids (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
-- Caixa de correio: mensagem fica aqui até o destinatário confirmar que salvou.
CREATE TABLE IF NOT EXISTS mailbox (
  user_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
-- Arquivos enviados: o conteúdo fica em <dados>/arquivos/<id> até todos baixarem ou expirar.
CREATE TABLE IF NOT EXISTS files (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  uploader_id     TEXT NOT NULL,
  name            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  mime            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  attached        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sounds (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS file_pending (
  file_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (file_id, user_id)
);
`;

export type FileRow = {
  id: string;
  conversation_id: string;
  uploader_id: string;
  name: string;
  size: number;
  mime: string;
  created_at: number;
  attached: number;
};

type UserRow = UserPublic & { password_hash: string; is_admin: number };

export class Db {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(invites)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('max_uses')) {
      this.db.exec(`
        ALTER TABLE invites ADD COLUMN max_uses INTEGER DEFAULT 1;
        ALTER TABLE invites ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE invites ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0;
        UPDATE invites SET uses = 1 WHERE used_by IS NOT NULL;
      `);
    }
    const ucols = (this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
    if (!ucols.includes('status_text')) {
      this.db.exec(`
        ALTER TABLE users ADD COLUMN status_text TEXT NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN status_emoji TEXT NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN availability TEXT NOT NULL DEFAULT 'online';
      `);
    }
    this.ensureDefaultRoom();
  }

  // ---- salas fixas (todo mundo participa) ----

  /** Servidor sem sala: cria a "Sala geral" com todos os usuários. */
  private ensureDefaultRoom(): void {
    if (this.db.prepare("SELECT 1 FROM conversations WHERE type = 'ROOM' LIMIT 1").get()) return;
    const id = ulid();
    const now = Date.now();
    this.db.prepare("INSERT INTO conversations (id, type, name, created_at) VALUES (?, 'ROOM', 'Sala geral', ?)").run(id, now);
    this.db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) SELECT ?, id, ? FROM users').run(id, now);
  }

  createRoom(name: string): Conversation {
    const id = ulid();
    const now = Date.now();
    this.db.prepare("INSERT INTO conversations (id, type, name, created_at) VALUES (?, 'ROOM', ?, ?)").run(id, name, now);
    this.db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) SELECT ?, id, ? FROM users').run(id, now);
    return this.conversation(id)!;
  }

  renameRoom(id: string, name: string): Conversation | undefined {
    this.db.prepare("UPDATE conversations SET name = ? WHERE id = ? AND type = 'ROOM'").run(name, id);
    return this.conversation(id);
  }

  /** Apaga a sala (o histórico de cada um continua no próprio PC). Devolve quem era membro. */
  deleteRoom(id: string): string[] {
    const members = this.memberIds(id);
    this.db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(id);
    this.db.prepare("DELETE FROM conversations WHERE id = ? AND type = 'ROOM'").run(id);
    return members;
  }

  roomIds(): string[] {
    return (this.db.prepare("SELECT id FROM conversations WHERE type = 'ROOM'").all() as { id: string }[]).map((r) => r.id);
  }

  /** Quem me interessa saber se está online: amigos + quem divide conversa comigo (salas). */
  contactIds(userId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m2.user_id AS id FROM conversation_members m1
           JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
          WHERE m1.user_id = ? AND m2.user_id != ?`,
      )
      .all(userId, userId) as { id: string }[];
    return [...new Set([...rows.map((r) => r.id), ...this.acceptedFriendIds(userId)])];
  }

  // ---- status ----

  status(userId: string): UserStatus {
    const r = this.db.prepare('SELECT status_text, status_emoji, availability FROM users WHERE id = ?').get(userId) as
      | { status_text: string; status_emoji: string; availability: string }
      | undefined;
    const a = r?.availability;
    return { availability: a === 'idle' || a === 'dnd' ? a : 'online', text: r?.status_text ?? '', emoji: r?.status_emoji ?? '' };
  }

  setStatus(userId: string, s: UserStatus): void {
    this.db.prepare('UPDATE users SET status_text = ?, status_emoji = ?, availability = ? WHERE id = ?').run(s.text, s.emoji, s.availability, userId);
  }

  isAdminId(userId: string): boolean {
    return !!(this.db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId) as { is_admin: number } | undefined)?.is_admin;
  }

  // ---- soundboard ----

  sounds(): Sound[] {
    return this.db.prepare('SELECT id, name, emoji, uploader_id, size FROM sounds ORDER BY created_at').all() as Sound[];
  }

  sound(id: string): (Sound & { mime: string }) | undefined {
    return this.db.prepare('SELECT id, name, emoji, uploader_id, size, mime FROM sounds WHERE id = ?').get(id) as
      | (Sound & { mime: string })
      | undefined;
  }

  addSound(s: Sound & { mime: string }): void {
    this.db
      .prepare('INSERT INTO sounds (id, name, emoji, uploader_id, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.name, s.emoji, s.uploader_id, s.mime, s.size, Date.now());
  }

  deleteSound(id: string): void {
    this.db.prepare('DELETE FROM sounds WHERE id = ?').run(id);
  }

  soundCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sounds').get() as { n: number }).n;
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- users / sessions / invites ----

  userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  createUser(username: string, displayName: string, passwordHash: string, isAdmin: boolean): UserPublic {
    const id = ulid();
    this.db
      .prepare('INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, username, displayName, passwordHash, isAdmin ? 1 : 0, Date.now());
    // Quem chega entra em todas as salas fixas.
    const ins = this.db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)');
    for (const room of this.roomIds()) ins.run(room, id, Date.now());
    return { id, username, display_name: displayName };
  }

  userByUsername(username: string): UserRow | undefined {
    return this.db
      .prepare('SELECT id, username, display_name, password_hash, is_admin FROM users WHERE username = ?')
      .get(username) as UserRow | undefined;
  }

  userById(id: string): UserPublic | undefined {
    return this.db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(id) as UserPublic | undefined;
  }

  createSession(tokenHash: string, userId: string, deviceName: string): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, device_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash, userId, deviceName, now, now);
  }

  userBySession(tokenHash: string): UserPublic | undefined {
    const row = this.db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { user_id: string }
      | undefined;
    if (!row) return undefined;
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), tokenHash);
    return this.userById(row.user_id);
  }

  /** maxUses null = ilimitado. */
  createInvite(code: string, createdBy: string, maxUses: number | null = 1): void {
    this.db
      .prepare('INSERT INTO invites (code, created_by, created_at, max_uses) VALUES (?, ?, ?, ?)')
      .run(code, createdBy, Date.now(), maxUses);
  }

  /** Conta um uso do convite; retorna false se não existe, foi revogado ou esgotou. */
  consumeInvite(code: string, usedBy: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE invites SET uses = uses + 1, used_by = ?, used_at = ?
          WHERE code = ? AND revoked = 0 AND (max_uses IS NULL OR uses < max_uses)`,
      )
      .run(usedBy, Date.now(), code);
    return r.changes === 1;
  }

  inviteAvailable(code: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM invites WHERE code = ? AND revoked = 0 AND (max_uses IS NULL OR uses < max_uses)')
      .get(code);
  }

  isAdmin(userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM users WHERE id = ? AND is_admin = 1').get(userId);
  }

  // ---- friends ----

  private pair(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  friendship(a: string, b: string): { requested_by: string; status: string } | undefined {
    const [lo, hi] = this.pair(a, b);
    return this.db
      .prepare('SELECT requested_by, status FROM friendships WHERE user_low = ? AND user_high = ?')
      .get(lo, hi) as { requested_by: string; status: string } | undefined;
  }

  requestFriend(from: string, to: string): void {
    const [lo, hi] = this.pair(from, to);
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO friendships (user_low, user_high, requested_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(lo, hi, from, 'PENDING', now, now);
  }

  acceptFriend(a: string, b: string): void {
    const [lo, hi] = this.pair(a, b);
    this.db
      .prepare("UPDATE friendships SET status = 'ACCEPTED', updated_at = ? WHERE user_low = ? AND user_high = ?")
      .run(Date.now(), lo, hi);
  }

  removeFriend(a: string, b: string): void {
    const [lo, hi] = this.pair(a, b);
    this.db.prepare('DELETE FROM friendships WHERE user_low = ? AND user_high = ?').run(lo, hi);
  }

  friendsOf(userId: string): Friend[] {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name, f.status, f.requested_by
           FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.user_low = ? THEN f.user_high ELSE f.user_low END
          WHERE f.user_low = ? OR f.user_high = ?
          ORDER BY u.display_name`,
      )
      .all(userId, userId, userId) as (UserPublic & { status: string; requested_by: string })[];
    return rows.map((r) => {
      let status: FriendStatus = 'ACCEPTED';
      if (r.status === 'PENDING') status = r.requested_by === userId ? 'OUTGOING' : 'INCOMING';
      return { user: { id: r.id, username: r.username, display_name: r.display_name }, status };
    });
  }

  acceptedFriendIds(userId: string): string[] {
    return this.friendsOf(userId)
      .filter((f) => f.status === 'ACCEPTED')
      .map((f) => f.user.id);
  }

  // ---- conversations ----

  private members(conversationId: string): UserPublic[] {
    return this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name FROM conversation_members m
           JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY m.joined_at`,
      )
      .all(conversationId) as UserPublic[];
  }

  memberIds(conversationId: string): string[] {
    return (
      this.db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId) as {
        user_id: string;
      }[]
    ).map((r) => r.user_id);
  }

  isMember(conversationId: string, userId: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(conversationId, userId);
  }

  conversation(id: string): Conversation | undefined {
    const row = this.db.prepare('SELECT id, type, name, owner_id FROM conversations WHERE id = ?').get(id) as
      | Omit<Conversation, 'members'>
      | undefined;
    return row && { ...row, members: this.members(id) };
  }

  conversationsOf(userId: string): Conversation[] {
    const ids = this.db
      .prepare(
        `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
          WHERE m.user_id = ? ORDER BY c.created_at`,
      )
      .all(userId) as { id: string }[];
    return ids.map((r) => this.conversation(r.id)!);
  }

  /** Conversa DIRECT entre dois usuários, criando se não existir. */
  ensureDirect(a: string, b: string): Conversation {
    const key = this.pair(a, b).join(':');
    const existing = this.db.prepare('SELECT id FROM conversations WHERE direct_key = ?').get(key) as
      | { id: string }
      | undefined;
    if (existing) return this.conversation(existing.id)!;
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO conversations (id, type, direct_key, created_at) VALUES (?, 'DIRECT', ?, ?)")
      .run(id, key, now);
    for (const u of [a, b]) {
      this.db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, u, now);
    }
    return this.conversation(id)!;
  }

  createGroup(ownerId: string, name: string, memberIds: string[]): Conversation {
    const id = ulid();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO conversations (id, type, name, owner_id, created_at) VALUES (?, 'GROUP', ?, ?, ?)")
      .run(id, name, ownerId, now);
    for (const u of new Set([ownerId, ...memberIds])) {
      this.db.prepare('INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, u, now);
    }
    return this.conversation(id)!;
  }

  // ---- messages / mailbox ----

  existingMessage(id: string): { conversation_id: string; sender_id: string; created_at: number } | undefined {
    return this.db.prepare('SELECT conversation_id, sender_id, created_at FROM message_ids WHERE id = ?').get(id) as
      | { conversation_id: string; sender_id: string; created_at: number }
      | undefined;
  }

  /** Registra a mensagem e deixa uma cópia na caixa de cada destinatário. */
  storeMessage(msg: Message, recipients: string[]): void {
    this.db
      .prepare('INSERT INTO message_ids (id, conversation_id, sender_id, created_at) VALUES (?, ?, ?, ?)')
      .run(msg.id, msg.conversation_id, msg.sender_id, msg.created_at);
    const payload = JSON.stringify(msg);
    const ins = this.db.prepare('INSERT INTO mailbox (user_id, message_id, payload, created_at) VALUES (?, ?, ?, ?)');
    for (const u of recipients) ins.run(u, msg.id, payload, msg.created_at);
  }

  mailboxFor(userId: string): Message[] {
    return (
      this.db.prepare('SELECT payload FROM mailbox WHERE user_id = ? ORDER BY created_at').all(userId) as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload) as Message);
  }

  // ---- arquivos ----

  createFile(f: Omit<FileRow, 'attached'>): void {
    this.db
      .prepare('INSERT INTO files (id, conversation_id, uploader_id, name, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(f.id, f.conversation_id, f.uploader_id, f.name, f.size, f.mime, f.created_at);
  }

  file(id: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
  }

  /** Arquivo virou mensagem: cada destinatário precisa baixar. */
  attachFile(id: string, recipients: string[]): void {
    this.db.prepare('UPDATE files SET attached = 1 WHERE id = ?').run(id);
    const ins = this.db.prepare('INSERT OR IGNORE INTO file_pending (file_id, user_id) VALUES (?, ?)');
    for (const u of recipients) ins.run(id, u);
  }

  /** Marca que esse usuário baixou. Retorna quantos ainda faltam. */
  fileDownloaded(id: string, userId: string): number {
    this.db.prepare('DELETE FROM file_pending WHERE file_id = ? AND user_id = ?').run(id, userId);
    return (this.db.prepare('SELECT COUNT(*) AS n FROM file_pending WHERE file_id = ?').get(id) as { n: number }).n;
  }

  deleteFile(id: string): void {
    this.db.prepare('DELETE FROM file_pending WHERE file_id = ?').run(id);
    this.db.prepare('DELETE FROM files WHERE id = ?').run(id);
  }

  /** Expirados, e uploads que nunca viraram mensagem. */
  staleFiles(expiredBefore: number, orphanBefore: number): string[] {
    return (
      this.db
        .prepare('SELECT id FROM files WHERE created_at < ? OR (attached = 0 AND created_at < ?)')
        .all(expiredBefore, orphanBefore) as { id: string }[]
    ).map((r) => r.id);
  }

  allFileIds(): Set<string> {
    return new Set((this.db.prepare('SELECT id FROM files').all() as { id: string }[]).map((r) => r.id));
  }

  ackMailbox(userId: string, ids: string[]): void {
    const del = this.db.prepare('DELETE FROM mailbox WHERE user_id = ? AND message_id = ?');
    for (const id of ids) del.run(userId, id);
  }
}
