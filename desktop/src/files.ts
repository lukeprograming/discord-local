// Arquivos do chat: envio (upload com progresso pro host), download e prévia.
//
// O host guarda o arquivo até todos os destinatários baixarem (ou 7 dias). Cada
// aparelho guarda sua cópia: o PC em data/arquivos/, o celular no armazenamento do app.

import { useEffect, useSyncExternalStore } from 'react';
import { MAX_FILE_BYTES, type FileAttachment } from '../../shared/protocol.ts';
import { app } from './app.ts';

export type FileState =
  | { status: 'checking' }
  | { status: 'local'; path: string }
  | { status: 'remote' }
  | { status: 'downloading'; done: number; total: number }
  | { status: 'error'; error: string };

export type Upload = { key: string; conversationId: string; name: string; done: number; total: number; cancel: () => void };

const isAndroid = () => app.state.platform === 'android';
/** No celular só imagens até esse tamanho ficam dentro do app (prévia); o resto vai pelo navegador para Downloads. */
export const ANDROID_IN_APP_MAX = 25 * 1024 * 1024;
export const inApp = (att: FileAttachment) =>
  !isAndroid() || (att.mime.startsWith('image/') && att.size <= ANDROID_IN_APP_MAX);
/** Baixa sozinho ao receber até esse tamanho. */
const autoOk = (att: FileAttachment) => inApp(att) && att.size <= (isAndroid() ? 15 : 200) * 1024 * 1024;

const states = new Map<string, FileState>();
let uploads: Upload[] = [];
let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

window.native.onFileProgress?.(({ id, done, total }) => {
  const st = states.get(id);
  if (st?.status === 'downloading') {
    states.set(id, { status: 'downloading', done, total });
    bump();
  }
});

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`.replace('.', ',');
}

function session(): { url: string; token: string } {
  const p = app.state.profile;
  if (!p) throw new Error('sem sessão');
  return { url: p.server_url.replace(/\/$/, ''), token: p.token };
}

async function check(convId: string, att: FileAttachment): Promise<void> {
  if (states.has(att.id)) return;
  states.set(att.id, { status: 'checking' });
  const path = await window.native.fileLocal?.(convId, att).catch(() => null);
  if (states.get(att.id)?.status !== 'checking') return;
  states.set(att.id, path ? { status: 'local', path } : { status: 'remote' });
  bump();
}

/** Estado do arquivo neste aparelho (redesenha quando muda). */
export function useFile(convId: string, att: FileAttachment): FileState {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    check(convId, att).then(() => {
      if (states.get(att.id)?.status === 'remote' && autoOk(att)) download(convId, att).catch(() => {});
    });
  }, [convId, att.id]);
  return states.get(att.id) ?? { status: 'checking' };
}

export function useUploads(convId: string): Upload[] {
  useSyncExternalStore(subscribe, () => version);
  return uploads.filter((u) => u.conversationId === convId);
}

export async function download(convId: string, att: FileAttachment): Promise<string> {
  const st = states.get(att.id);
  if (st?.status === 'local') return st.path;
  if (!window.native.fileDownload) throw new Error('indisponível');
  if (!inApp(att)) {
    await downloadInBrowser(att);
    return '';
  }
  states.set(att.id, { status: 'downloading', done: 0, total: att.size });
  bump();
  try {
    const { url, token } = session();
    const path = await window.native.fileDownload(url, token, convId, att);
    states.set(att.id, { status: 'local', path });
    return path;
  } catch (e) {
    states.set(att.id, { status: 'error', error: (e as Error).message });
    throw e;
  } finally {
    bump();
  }
}

/** Chamado ao receber a mensagem: baixa já se for pequeno (o host apaga quando todos baixam). */
export function autoDownload(convId: string, att: FileAttachment): void {
  if (!autoOk(att)) return;
  check(convId, att)
    .then(() => (states.get(att.id)?.status === 'remote' ? download(convId, att) : undefined))
    .catch(() => {});
}

/** Celular, arquivo grande: o navegador baixa para a pasta Downloads (link de uso único). */
export async function downloadInBrowser(att: FileAttachment): Promise<void> {
  const { url, token } = session();
  const res = await fetch(`${url}/files/${att.id}/ticket`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  await window.native.openUrl?.(`${url}/files/${att.id}?ticket=${encodeURIComponent(body.ticket)}`);
}

const previews = new Map<string, Promise<string>>(); // id -> blob: URL

/** Prévia (imagens) a partir da cópia local. */
export function preview(path: string, att: FileAttachment): Promise<string> {
  let p = previews.get(att.id);
  if (!p) {
    p = window.native.fileRead!(path).then((bytes) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: att.mime })));
    p.catch(() => previews.delete(att.id));
    previews.set(att.id, p);
  }
  return p;
}

/** Sobe os arquivos escolhidos/arrastados/colados e manda uma mensagem para cada um. */
export function sendFiles(convId: string, list: FileList | File[]): void {
  for (const file of Array.from(list)) {
    if (!file.size) {
      app.toast(`"${file.name}" está vazio (ou é uma pasta).`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      app.toast(`"${file.name}" passa de 2 GB.`);
      continue;
    }
    sendOne(convId, file).catch((e) => app.toast(`Não consegui enviar "${file.name}": ${(e as Error).message}`));
  }
}

async function sendOne(convId: string, file: File): Promise<void> {
  if (app.state.connection !== 'online') throw new Error('sem conexão com o host');
  const { url, token } = session();
  const name = file.name || `colado-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${(file.type.split('/')[1] || 'bin').replace(/\W/g, '')}`;
  const xhr = new XMLHttpRequest();
  const key = Math.random().toString(36).slice(2);
  const up: Upload = { key, conversationId: convId, name, done: 0, total: file.size, cancel: () => xhr.abort() };
  uploads = [...uploads, up];
  bump();
  const remove = () => {
    uploads = uploads.filter((u) => u.key !== key);
    bump();
  };

  let att: FileAttachment;
  try {
    att = await new Promise<FileAttachment>((resolve, reject) => {
      xhr.open('POST', `${url}/files?conversation_id=${encodeURIComponent(convId)}&name=${encodeURIComponent(name)}`);
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        up.done = e.loaded;
        bump();
      };
      xhr.onload = () => {
        let body: { error?: string } & Partial<FileAttachment> = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* resposta vazia */
        }
        if (xhr.status === 200 && body.id) resolve({ kind: 'file', id: body.id, name: body.name!, size: body.size!, mime: body.mime! });
        else reject(new Error(body.error ?? `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('falha de rede'));
      xhr.onabort = () => reject(new DOMException('cancelado', 'AbortError'));
      xhr.send(file);
    });
  } catch (e) {
    remove();
    if ((e as Error).name === 'AbortError') return;
    throw e;
  }

  // Minha cópia local, para o histórico continuar abrindo o arquivo depois que o host apagar.
  try {
    const source = window.native.pathForFile?.(file) || (file.size <= ANDROID_IN_APP_MAX ? new Uint8Array(await file.arrayBuffer()) : null);
    if (source && window.native.fileKeepSent) {
      const path = await window.native.fileKeepSent(convId, att, source);
      states.set(att.id, { status: 'local', path });
    }
  } catch (e) {
    console.warn('[files] cópia local', e);
  }
  remove();
  await app.sendFile(convId, att);
}
