import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Db } from './db.ts';
import { Gateway } from './gateway.ts';
import { hashPassword, newToken, RateLimiter, USERNAME_RE, verifyPassword } from './auth.ts';

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
    res.setHeader('access-control-allow-headers', 'content-type');
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
      json(res, 404, { error: 'não encontrado' });
    } catch (e) {
      console.error('[server]', req.url, e);
      json(res, 400, { error: 'requisição inválida' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // Só depois do listen: o ws repassa erros do servidor (ex.: porta em uso) e, sem ouvinte, viram exceção não tratada.
  const wss = new WebSocketServer({ server, path: '/gateway', maxPayload: 256 * 1024 });
  wss.on('connection', (ws) => gateway.attach(ws));
  const url = `http://${opts.host}:${opts.port}`;
  console.log(`[server] ouvindo em ${url}  (banco: ${dbPath})`);
  if (db.userCount() === 0) console.log('[server] nenhum usuário ainda: o primeiro cadastro vira admin, sem convite');

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
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
