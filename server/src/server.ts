import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { FILE_TTL_MS, MAX_FILE_BYTES, MAX_SOUND_BYTES, MAX_SOUNDS } from '../../shared/protocol.ts';
import { ulid, ULID_RE } from './ids.ts';
import { WebSocketServer } from 'ws';
import { Db } from './db.ts';
import { Gateway } from './gateway.ts';
import { hashPassword, hashToken, newToken, RateLimiter, USERNAME_RE, verifyPassword } from './auth.ts';

export type ServerOptions = {
  host: string;
  port: number;
  dataDir: string;
  /** Nome exibido aos conectados (ex.: "Servidor do Lucas"). */
  name?: string;
};

export type RunningServer = {
  url: string;
  close(): Promise<void>;
};

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const dbPath = join(opts.dataDir, 'app.db');
  const db = new Db(dbPath);
  const gateway = new Gateway(db);
  const authLimiter = new RateLimiter(10, 60_000);

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024) throw new Error('corpo grande demais');
      chunks.push(chunk);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  }

  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  // ---- arquivos (o conteúdo fica em <dados>/arquivos/<id> até todos baixarem) ----

  const filesDir = join(opts.dataDir, 'arquivos');
  mkdirSync(filesDir, { recursive: true });
  const filePath = (id: string) => join(filesDir, id);
  // Link de download de uso único (o celular baixa pelo navegador, sem expor o token da sessão).
  const tickets = new Map<string, { fileId: string; userId: string; exp: number }>();

  function authUser(req: IncomingMessage) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    return m ? db.userBySession(hashToken(m[1])) : undefined;
  }

  function removeFile(id: string) {
    db.deleteFile(id);
    try {
      unlinkSync(filePath(id));
    } catch {
      /* já não existe */
    }
  }

  function reapFiles() {
    const now = Date.now();
    for (const id of db.staleFiles(now - FILE_TTL_MS, now - 24 * 3600_000)) removeFile(id);
    // Sobras no disco sem registro (upload interrompido, crash).
    const known = db.allFileIds();
    for (const name of readdirSync(filesDir)) {
      const id = name.replace(/\.part$/, '');
      if (known.has(id) && !name.endsWith('.part')) continue;
      try {
        if (now - statSync(join(filesDir, name)).mtimeMs > 3600_000) unlinkSync(join(filesDir, name));
      } catch {
        /* ignora */
      }
    }
    for (const [t, v] of tickets) if (v.exp < now) tickets.delete(t);
  }
  reapFiles();
  const reapTimer = setInterval(reapFiles, 3600_000);

  async function upload(req: IncomingMessage, res: ServerResponse, url: URL) {
    const user = authUser(req);
    if (!user) return json(res, 401, { error: 'sessão inválida' });
    const conversationId = url.searchParams.get('conversation_id') ?? '';
    if (!db.isMember(conversationId, user.id)) return json(res, 403, { error: 'conversa não encontrada' });
    const name = (url.searchParams.get('name') ?? '').replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'arquivo';
    const size = Number(req.headers['content-length']);
    if (!Number.isInteger(size) || size <= 0) return json(res, 411, { error: 'tamanho do arquivo ausente' });
    if (size > MAX_FILE_BYTES) return json(res, 413, { error: 'arquivo grande demais (máx. 2 GB)' });
    const mime = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);

    const id = ulid();
    const part = filePath(id) + '.part';
    const out = createWriteStream(part);
    let received = 0;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      out.destroy();
      try {
        unlinkSync(part);
      } catch {
        /* ignora */
      }
    };
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > size) {
        fail();
        json(res, 413, { error: 'arquivo maior que o anunciado' });
        req.destroy();
      }
    });
    req.on('aborted', fail);
    req.pipe(out);
    out.on('error', () => {
      fail();
      if (!res.headersSent) json(res, 500, { error: 'não consegui gravar o arquivo' });
    });
    out.on('finish', () => {
      if (failed) return;
      if (received !== size) {
        fail();
        return json(res, 400, { error: 'upload incompleto' });
      }
      renameSync(part, filePath(id));
      db.createFile({ id, conversation_id: conversationId, uploader_id: user.id, name, size, mime, created_at: Date.now() });
      json(res, 200, { id, name, size, mime });
    });
  }

  function download(req: IncomingMessage, res: ServerResponse, id: string, url: URL) {
    let user: { id: string } | undefined = authUser(req);
    const ticket = url.searchParams.get('ticket');
    if (!user && ticket) {
      const t = tickets.get(ticket);
      tickets.delete(ticket);
      if (t && t.fileId === id && t.exp > Date.now()) user = { id: t.userId };
    }
    if (!user) return json(res, 401, { error: 'sessão inválida' });
    const f = db.file(id);
    if (!f || !db.isMember(f.conversation_id, user.id)) return json(res, 404, { error: 'arquivo não encontrado (expirou?)' });
    const userId = user.id;
    res.writeHead(200, {
      'content-type': f.mime,
      'content-length': f.size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    });
    const stream = createReadStream(filePath(id));
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    res.on('finish', () => {
      if (userId === f.uploader_id) return;
      if (db.fileDownloaded(id, userId) === 0 && f.attached) removeFile(id);
    });
  }

  // ---- soundboard (sons curtos, ficam no host em <dados>/sons/<id>) ----

  const soundsDir = join(opts.dataDir, 'sons');
  mkdirSync(soundsDir, { recursive: true });
  gateway.onSoundDeleted = (id) => {
    try {
      unlinkSync(join(soundsDir, id));
    } catch {
      /* já não existe */
    }
  };

  async function uploadSound(req: IncomingMessage, res: ServerResponse, url: URL) {
    const user = authUser(req);
    if (!user) return json(res, 401, { error: 'sessão inválida' });
    const name = (url.searchParams.get('name') ?? '').trim().slice(0, 40);
    const emoji = (url.searchParams.get('emoji') ?? '').trim().slice(0, 16) || '🔊';
    const mime = String(req.headers['content-type'] || '').slice(0, 100);
    if (!name) return json(res, 400, { error: 'dê um nome ao som' });
    if (!mime.startsWith('audio/')) return json(res, 415, { error: 'precisa ser um arquivo de áudio' });
    if (db.soundCount() >= MAX_SOUNDS) return json(res, 409, { error: `o soundboard já tem ${MAX_SOUNDS} sons; apague algum` });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_SOUND_BYTES) return json(res, 413, { error: 'som grande demais (máx. 1 MB)' });
      chunks.push(c as Buffer);
    }
    if (!size) return json(res, 400, { error: 'arquivo vazio' });
    const id = ulid();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(soundsDir, id), Buffer.concat(chunks));
    db.addSound({ id, name, emoji, uploader_id: user.id, mime, size });
    gateway.broadcastSounds();
    json(res, 200, { id });
  }

  function getSound(req: IncomingMessage, res: ServerResponse, id: string) {
    if (!authUser(req)) return json(res, 401, { error: 'sessão inválida' });
    const snd = db.sound(id);
    if (!snd) return json(res, 404, { error: 'som não encontrado' });
    res.writeHead(200, { 'content-type': snd.mime, 'content-length': snd.size, 'cache-control': 'private, max-age=31536000, immutable' });
    createReadStream(join(soundsDir, id)).on('error', () => res.destroy()).pipe(res);
  }

  // ---- transferências da pasta compartilhada (link de uso único, apagam depois de baixadas ou em 1 h) ----

  const transfersDir = join(opts.dataDir, 'transferencias');
  mkdirSync(transfersDir, { recursive: true });
  const transfers = new Map<string, { name: string; size: number; to: string; exp: number }>();
  for (const f of readdirSync(transfersDir)) {
    try {
      unlinkSync(join(transfersDir, f));
    } catch {
      /* ignora */
    }
  }
  const dropTransfer = (id: string) => {
    transfers.delete(id);
    try {
      unlinkSync(join(transfersDir, id));
    } catch {
      /* já não existe */
    }
  };
  const transferTimer = setInterval(() => {
    for (const [id, t] of transfers) if (t.exp < Date.now()) dropTransfer(id);
  }, 60_000);

  function uploadTransfer(req: IncomingMessage, res: ServerResponse, url: URL) {
    const user = authUser(req);
    if (!user) return json(res, 401, { error: 'sessão inválida' });
    const to = url.searchParams.get('to') ?? '';
    if (!db.contactIds(user.id).includes(to)) return json(res, 403, { error: 'destinatário inválido' });
    const name = (url.searchParams.get('name') ?? '').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'arquivo';
    const size = Number(req.headers['content-length']);
    if (!Number.isInteger(size) || size < 0) return json(res, 411, { error: 'tamanho ausente' });
    if (size > MAX_FILE_BYTES) return json(res, 413, { error: 'arquivo grande demais (máx. 2 GB)' });
    const id = randomBytes(24).toString('base64url');
    const out = createWriteStream(join(transfersDir, id));
    let received = 0;
    req.on('data', (c: Buffer) => (received += c.length));
    req.on('aborted', () => dropTransfer(id));
    req.pipe(out);
    out.on('finish', () => {
      if (received !== size) {
        dropTransfer(id);
        return json(res, 400, { error: 'envio incompleto' });
      }
      transfers.set(id, { name, size, to, exp: Date.now() + 3600_000 });
      json(res, 200, { url: `/transfers/${id}` });
    });
  }

  function downloadTransfer(res: ServerResponse, id: string) {
    const t = transfers.get(id);
    if (!t) return json(res, 404, { error: 'link expirado ou já usado' });
    transfers.delete(id); // uso único
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': t.size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(t.name)}`,
    });
    const st = createReadStream(join(transfersDir, id));
    st.on('error', () => res.destroy());
    st.pipe(res);
    res.on('close', () => dropTransfer(id));
  }

  function newTicket(req: IncomingMessage, res: ServerResponse, id: string) {
    const user = authUser(req);
    if (!user) return json(res, 401, { error: 'sessão inválida' });
    const f = db.file(id);
    if (!f || !db.isMember(f.conversation_id, user.id)) return json(res, 404, { error: 'arquivo não encontrado (expirou?)' });
    const t = randomBytes(18).toString('base64url');
    tickets.set(t, { fileId: id, userId: user.id, exp: Date.now() + 10 * 60_000 });
    json(res, 200, { ticket: t });
  }

  async function register(body: Record<string, unknown>) {
    const username = str(body.username);
    const displayName = str(body.display_name) || username;
    const password = typeof body.password === 'string' ? body.password : '';
    const invite = str(body.invite_code).toUpperCase();
    if (!USERNAME_RE.test(username)) return [400, { error: 'usuário: 3 a 24 caracteres (letras, números, _ . -)' }] as const;
    if (password.length < 6) return [400, { error: 'senha precisa de pelo menos 6 caracteres' }] as const;
    if (displayName.length > 32) return [400, { error: 'nome de exibição longo demais' }] as const;
    if (db.userByUsername(username)) return [409, { error: 'esse usuário já existe' }] as const;

    // O primeiro usuário vira admin sem convite; os demais precisam de um.
    const first = db.userCount() === 0;
    if (!first && !db.inviteAvailable(invite)) return [403, { error: 'código de convite inválido ou já usado' }] as const;

    const hash = await hashPassword(password);
    const { token, hash: tokenHash } = newToken();
    const user = db.tx(() => {
      const u = db.createUser(username, displayName, hash, first);
      if (!first && !db.consumeInvite(invite, u.id)) throw new Error('convite consumido em paralelo');
      db.createSession(tokenHash, u.id, str(body.device_name).slice(0, 64) || 'desconhecido');
      return u;
    });
    console.log(`[server] novo usuário: ${username}${first ? ' (admin)' : ''}`);
    gateway.refreshRooms();
    return [200, { token, user }] as const;
  }

  async function login(body: Record<string, unknown>) {
    const row = db.userByUsername(str(body.username));
    const ok = row && (await verifyPassword(typeof body.password === 'string' ? body.password : '', row.password_hash));
    if (!row || !ok) return [401, { error: 'usuário ou senha incorretos' }] as const;
    const { token, hash } = newToken();
    db.createSession(hash, row.id, str(body.device_name).slice(0, 64) || 'desconhecido');
    return [200, { token, user: { id: row.id, username: row.username, display_name: row.display_name } }] as const;
  }

  const server = createServer(async (req, res) => {
    // O app Electron carrega de file:// (origin "null"); auth é por token, sem cookies.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, { ok: true, name: 'discord-local', server_name: opts.name ?? null, needs_setup: db.userCount() === 0 });
      }
      if (req.method === 'POST' && (req.url === '/auth/register' || req.url === '/auth/login')) {
        if (!authLimiter.allow(req.socket.remoteAddress ?? '')) return json(res, 429, { error: 'muitas tentativas, espere um minuto' });
        const body = await readJson(req);
        const [status, out] = req.url === '/auth/register' ? await register(body) : await login(body);
        return json(res, status, out);
      }
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/files') return upload(req, res, url);
      if (req.method === 'POST' && url.pathname === '/sounds') return await uploadSound(req, res, url);
      if (req.method === 'POST' && url.pathname === '/transfers') return uploadTransfer(req, res, url);
      const tm = /^\/transfers\/([A-Za-z0-9_-]{32})$/.exec(url.pathname);
      if (tm && req.method === 'GET') return downloadTransfer(res, tm[1]);
      const sm = /^\/sounds\/([0-9A-Z]{26})$/.exec(url.pathname);
      if (sm && req.method === 'GET' && ULID_RE.test(sm[1])) return getSound(req, res, sm[1]);
      const fm = /^\/files\/([0-9A-Z]{26})(\/ticket)?$/.exec(url.pathname);
      if (fm && ULID_RE.test(fm[1])) {
        if (req.method === 'GET' && !fm[2]) return download(req, res, fm[1], url);
        if (req.method === 'POST' && fm[2]) return newTicket(req, res, fm[1]);
      }
      json(res, 404, { error: 'não encontrado' });
    } catch (e) {
      console.error('[server]', req.url, e);
      json(res, 400, { error: 'requisição inválida' });
    }
  });

  // Upload/download de arquivo grande pela VPN passa fácil dos 5 min padrão do Node.
  server.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Só depois do listen: o ws repassa erros do servidor (ex.: porta em uso) e, sem ouvinte, viram exceção não tratada.
  const wss = new WebSocketServer({ server, path: '/gateway', maxPayload: 2 * 1024 * 1024 });
  wss.on('connection', (ws) => gateway.attach(ws));
  const url = `http://${opts.host}:${opts.port}`;
  console.log(`[server] ouvindo em ${url}  (banco: ${dbPath})`);
  if (db.userCount() === 0) console.log('[server] nenhum usuário ainda: o primeiro cadastro vira admin, sem convite');

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(reapTimer);
        clearInterval(transferTimer);
        gateway.shutdown();
        wss.close();
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
