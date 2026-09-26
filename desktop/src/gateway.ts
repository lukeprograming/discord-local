import type { ClientOpResults, ClientOps, ServerOps } from '../../shared/protocol.ts';

type Listener<K extends keyof ServerOps> = (d: ServerOps[K]) => void;
type Status = 'offline' | 'connecting' | 'online';

const PING_MS = 20_000;
const ACK_TIMEOUT_MS = 15_000;

export class RequestError extends Error {}

/** WebSocket com reconexão automática. Comandos com ack viram Promise. */
export class GatewayClient {
  status: Status = 'offline';
  onStatus: (s: Status) => void = () => {};
  onAuthFailed: () => void = () => {};

  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private listeners = new Map<string, Set<(d: unknown) => void>>();
  private pending = new Map<string, { ok: (d: unknown) => void; ko: (e: Error) => void; timer: number }>();
  private rid = 0;
  private retry = 0;
  private pingTimer = 0;
  private retryTimer = 0;
  private stopped = false;

  constructor(serverUrl: string, token: string) {
    this.url = serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/gateway';
    this.token = token;
  }

  connect(): void {
    this.stopped = false;
    this.setStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ op: 'hello', d: { token: this.token } }));
      this.pingTimer = window.setInterval(() => this.emit('ping', {}), PING_MS);
    };
    ws.onmessage = (ev) => {
      const env = JSON.parse(ev.data);
      if (env.op === 'ack') {
        const p = this.pending.get(env.rid);
        if (!p) return;
        this.pending.delete(env.rid);
        clearTimeout(p.timer);
        if (env.d.ok) p.ok(env.d.d);
        else p.ko(new RequestError(env.d.error ?? 'erro'));
        return;
      }
      if (env.op === 'ready') this.setStatus('online');
      for (const l of this.listeners.get(env.op) ?? []) l(env.d);
    };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      this.ws = null;
      for (const [rid, p] of this.pending) {
        clearTimeout(p.timer);
        p.ko(new Error('sem conexão'));
        this.pending.delete(rid);
      }
      this.setStatus('offline');
      if (ev.code === 4003) return this.onAuthFailed();
      if (this.stopped) return;
      // Backoff: 1s, 2s, 4s... até 15s.
      const delay = Math.min(15_000, 1000 * 2 ** this.retry++);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  /** Reconecta já (ex.: botão "tentar agora"). */
  reconnectNow(): void {
    if (this.ws) return;
    clearTimeout(this.retryTimer);
    this.retry = 0;
    this.connect();
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  on<K extends keyof ServerOps>(op: K, fn: Listener<K>): () => void {
    if (!this.listeners.has(op)) this.listeners.set(op, new Set());
    this.listeners.get(op)!.add(fn as (d: unknown) => void);
    return () => this.listeners.get(op)!.delete(fn as (d: unknown) => void);
  }

  /** Envia sem esperar resposta (typing, ping, sinais WebRTC). */
  emit<K extends keyof ClientOps>(op: K, d: ClientOps[K]): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ op, d }));
    return true;
  }

  request<K extends keyof ClientOps>(
    op: K,
    d: ClientOps[K],
  ): Promise<K extends keyof ClientOpResults ? ClientOpResults[K] : void> {
    return new Promise((ok, ko) => {
      if (this.status !== 'online' || !this.ws) return ko(new Error('sem conexão'));
      const rid = String(++this.rid);
      const timer = window.setTimeout(() => {
        this.pending.delete(rid);
        ko(new Error('servidor não respondeu'));
      }, ACK_TIMEOUT_MS);
      this.pending.set(rid, { ok: ok as (d: unknown) => void, ko, timer });
      this.ws.send(JSON.stringify({ op, d, rid }));
    });
  }

  private setStatus(s: Status): void {
    this.status = s;
    this.onStatus(s);
  }
}

export async function httpPost<T>(serverUrl: string, path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(serverUrl.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RequestError('não consegui falar com o servidor (endereço certo? VPN ligada?)');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new RequestError(data.error ?? `erro ${res.status}`);
  return data as T;
}

export async function checkServer(serverUrl: string): Promise<{ needs_setup: boolean }> {
  try {
    const res = await fetch(serverUrl.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    if (data.name !== 'discord-local') throw new Error();
    return data;
  } catch {
    throw new RequestError('servidor não encontrado nesse endereço');
  }
}
