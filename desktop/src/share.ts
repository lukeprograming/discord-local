// Pasta compartilhada: pedidos passam pelo host até o dono; o arquivo vai por um link de uso único.

import type { ShareRequest, ShareResponse } from '../../shared/protocol.ts';
import { app } from './app.ts';

const pending = new Map<string, { resolve: (r: ShareResponse) => void; timer: number }>();
const notified = new Set<string>();

function session() {
  const p = app.state.profile;
  if (!p) throw new Error('sem sessão');
  return { url: p.server_url.replace(/\/$/, ''), token: p.token };
}

/** Dono da pasta: responde os pedidos que chegam. */
app.shareRequest = async ({ from_user_id, req_id, req }) => {
  const root = app.state.profile?.settings?.shared_folder;
  const reply = (res: ShareResponse) => app.shareSend('share.response', { to_user_id: from_user_id, req_id, res }).catch(() => {});
  if (!root || !window.native.shareList) return reply({ ok: false, error: 'essa pessoa não está compartilhando nenhuma pasta' });
  try {
    if (req.type === 'list') {
      const entries = await window.native.shareList(root, req.path);
      return reply({ ok: true, type: 'list', path: req.path, entries });
    }
    if (req.type === 'get') {
      const who = app.user(from_user_id)?.display_name ?? 'Alguém';
      if (!notified.has(from_user_id)) {
        notified.add(from_user_id);
        app.toast(`📁 ${who} está baixando da sua pasta compartilhada`);
      }
      const { url, token } = session();
      const r = await window.native.shareUpload!(root, req.path, url, token, from_user_id);
      return reply({ ok: true, type: 'get', url: r.url, name: r.name, size: r.size });
    }
    reply({ ok: false, error: 'pedido desconhecido' });
  } catch (e) {
    reply({ ok: false, error: (e as Error).message });
  }
};

app.shareResponse = ({ req_id, res }) => {
  const p = pending.get(req_id);
  if (!p) return;
  pending.delete(req_id);
  clearTimeout(p.timer);
  p.resolve(res);
};

/** Pede algo à pasta de outra pessoa (a resposta vem pelo host). */
export async function ask(userId: string, req: ShareRequest): Promise<ShareResponse> {
  const req_id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const wait = new Promise<ShareResponse>((resolve) => {
    // Arquivo grande demora: o dono sobe tudo pro host antes de responder.
    const ms = req.type === 'get' ? 60 * 60_000 : 20_000;
    const timer = window.setTimeout(() => {
      pending.delete(req_id);
      resolve({ ok: false, error: 'a pessoa não respondeu (app fechado?)' });
    }, ms);
    pending.set(req_id, { resolve, timer });
  });
  await app.shareSend('share.request', { to_user_id: userId, req_id, req });
  return wait;
}

/** Baixa o arquivo pedido: no PC vai pra Downloads/Discord Local; no celular, pelo navegador. */
export async function fetchShared(key: string, link: string, name: string): Promise<string | null> {
  const full = session().url + link;
  if (window.native.shareDownload) return window.native.shareDownload(key, full, name);
  await window.native.openUrl?.(full);
  return null;
}
