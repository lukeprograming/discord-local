// window.native do Android: o mesmo contrato do preload do Electron (desktop/src/native.d.ts).
// Celular só conecta em host — servidor embutido, exportar instalador e VPN ficam no desktop.
//
// Directory.Data/
// ├── profile.json          servidor, token, cache de amigos/conversas
// ├── outbox.json           mensagens escritas e ainda não confirmadas pelo servidor
// └── conversas/<id>.jsonl  uma mensagem por linha, só cresce (append)

import { CapacitorHttp, registerPlugin } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { FileAttachment, Message } from '../../shared/protocol.ts';
import type { HostStatus, Profile, UpdateStatus } from '../../desktop/src/native.d.ts';
import { app } from '../../desktop/src/app.ts';

/** Plugin do próprio app (android/app/src/main/java/local/discord/app/DLNativePlugin.java). */
const DL = registerPlugin<{
  callActive(o: { active: boolean }): Promise<void>;
  setSpeaker(o: { on: boolean }): Promise<void>;
  openUrl(o: { url: string }): Promise<void>;
}>('DLNative');

const REPO = 'lukeprograming/discord-local';
const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const dir = Directory.Data;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const { data } = await Filesystem.readFile({ path, directory: dir, encoding: Encoding.UTF8 });
    return JSON.parse(data as string);
  } catch {
    return fallback;
  }
}

// Escreve num temporário e renomeia: se o celular desligar no meio, o arquivo antigo fica intacto.
async function writeJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await Filesystem.writeFile({ path: tmp, directory: dir, encoding: Encoding.UTF8, data: JSON.stringify(data) });
  await Filesystem.rename({ from: tmp, to: path, directory: dir, toDirectory: dir });
}

// Tudo que mexe no disco passa numa fila: appends da mesma conversa não se atropelam.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

const knownIds = new Map<string, Set<string>>(); // convId -> ids já gravados (dedupe)

function convFile(convId: string): string {
  if (!ID_RE.test(convId)) throw new Error(`id de conversa inválido: ${convId}`);
  return `conversas/${convId}.jsonl`;
}

async function loadMessages(convId: string): Promise<Message[]> {
  let text = '';
  try {
    text = (await Filesystem.readFile({ path: convFile(convId), directory: dir, encoding: Encoding.UTF8 })).data as string;
  } catch {
    /* conversa ainda sem arquivo */
  }
  const messages: Message[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Linha cortada no meio do append: ignora só ela.
    }
  }
  knownIds.set(convId, new Set(messages.map((m) => m.id)));
  messages.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  return messages;
}

async function appendMessages(convId: string, msgs: Message[]): Promise<Message[]> {
  if (!knownIds.has(convId)) await loadMessages(convId);
  const known = knownIds.get(convId)!;
  const fresh = msgs.filter((m) => m && ID_RE.test(m.id) && !known.has(m.id));
  if (!fresh.length) return [];
  // Começa com \n: se a última linha ficou cortada, a nova não cola nela (linhas vazias são ignoradas).
  await Filesystem.appendFile({
    path: convFile(convId),
    directory: dir,
    encoding: Encoding.UTF8,
    data: '\n' + fresh.map((m) => JSON.stringify(m)).join('\n') + '\n',
  });
  for (const m of fresh) known.add(m.id);
  return fresh;
}

// ---- atualização: o APK novo vem das Releases do GitHub e o Android instala ----

let version = '';
let update: UpdateStatus = { state: 'idle', current: '' };
const updateListeners = new Set<(s: UpdateStatus) => void>();
let apkUrl = '';

function setUpdate(patch: Partial<UpdateStatus>): UpdateStatus {
  update = { ...update, ...patch };
  for (const l of updateListeners) l(update);
  return update;
}

function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

async function checkUpdate(): Promise<UpdateStatus> {
  setUpdate({ state: 'checking' });
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    const rel = (await res.json()) as { tag_name: string; body?: string; assets: { name: string; browser_download_url: string }[] };
    const latest = rel.tag_name.replace(/^v/, '');
    const apk = rel.assets.find((a) => a.name.endsWith('.apk'));
    if (!apk || !newer(latest, version)) return setUpdate({ state: 'none', checked_at: Date.now() });
    apkUrl = apk.browser_download_url;
    return setUpdate({ state: 'available', version: latest, notes: rel.body, checked_at: Date.now() });
  } catch (e) {
    return setUpdate({ state: 'error', message: (e as Error).message });
  }
}

// ---- voltar do Android: sai da conversa; na lista, minimiza (não fecha — a call continua) ----

CapApp.addListener('backButton', () => {
  if (app.state.selected) app.select(null);
  else CapApp.minimizeApp();
});

// ---- arquivos do chat: só imagens ficam no app (prévia); o resto vai pelo navegador ----

function filePath(convId: string, att: FileAttachment): string {
  if (!ID_RE.test(convId) || !ID_RE.test(att.id)) throw new Error('id inválido');
  return `arquivos/${convId}/${att.id}`;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<string> {
  await Filesystem.writeFile({ path, directory: dir, data: toBase64(bytes), recursive: true });
  return path;
}

const fileApi = {
  fileLocal: async (convId: string, att: FileAttachment) => {
    const path = filePath(convId, att);
    try {
      await Filesystem.stat({ path, directory: dir });
      return path;
    } catch {
      return null;
    }
  },
  fileDownload: async (serverUrl: string, token: string, convId: string, att: FileAttachment) => {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/files/${att.id}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    return writeBytes(filePath(convId, att), new Uint8Array(await res.arrayBuffer()));
  },
  fileKeepSent: async (convId: string, att: FileAttachment, source: string | Uint8Array) => {
    if (typeof source === 'string' || !att.mime.startsWith('image/')) throw new Error('só imagens ficam no app');
    return writeBytes(filePath(convId, att), source);
  },
  fileRead: async (path: string) => {
    if (!/^arquivos\/[0-9A-Z]{26}\/[0-9A-Z]{26}$/.test(path)) throw new Error('caminho inválido');
    const { data } = await Filesystem.readFile({ path, directory: dir });
    const bin = atob(data as string);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  openUrl: (url: string) => DL.openUrl({ url }),
};

// ---- prévia de links (HTTP nativo: sem CORS) ----

const PREVIEW_UA = 'Mozilla/5.0 (compatible; DiscordLocal-LinkPreview/1.0; +https://github.com/lukeprograming/discord-local)';

async function fetchUrl(url: string, kind: 'page' | 'image') {
  if (!url.startsWith('https://')) throw new Error('só https');
  const headers = { 'User-Agent': PREVIEW_UA };
  // HEAD antes: não baixar vídeo/arquivo grande só pra prévia.
  const head = await CapacitorHttp.request({ method: 'HEAD', url, headers, connectTimeout: 7000, readTimeout: 7000 }).catch(() => null);
  const len = Number(head?.headers?.['Content-Length'] ?? head?.headers?.['content-length'] ?? 0);
  if (len > 8 * 1024 * 1024) throw new Error('grande demais');
  const res = await CapacitorHttp.get({ url, headers, responseType: 'arraybuffer', connectTimeout: 7000, readTimeout: 7000 });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const h = res.headers ?? {};
  const type = String(h['Content-Type'] ?? h['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const b64 = String(res.data ?? '');
  if (b64.length > 11 * 1024 * 1024) throw new Error('grande demais');
  if (type.startsWith('image/')) return { type, finalUrl: res.url ?? url, dataUrl: `data:${type};base64,${b64}` };
  if (kind === 'image' || !/html|xml/.test(type)) return { type, finalUrl: res.url ?? url };
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { type, finalUrl: res.url ?? url, text: new TextDecoder().decode(bytes) };
}

const noHost: HostStatus = { running: false };
const unsupported = () => Promise.reject(new Error('Indisponível no celular — use o app do computador.'));

window.native = {
  loadProfile: () => serial(() => readJson<Profile | null>('profile.json', null)),
  saveProfile: (p) =>
    serial(async () => {
      if (p === null) await Filesystem.deleteFile({ path: 'profile.json', directory: dir }).catch(() => {});
      else await writeJson('profile.json', p);
    }),
  loadMessages: (convId) => serial(() => loadMessages(convId)),
  appendMessages: (convId, msgs) => serial(() => appendMessages(convId, msgs)),
  loadOutbox: () => serial(() => readJson<Message[]>('outbox.json', [])),
  saveOutbox: (list) => serial(() => writeJson('outbox.json', list)),
  openDataDir: async () => {},
  info: async () => {
    await Filesystem.mkdir({ path: 'conversas', directory: dir, recursive: true }).catch(() => {});
    version = (await CapApp.getInfo()).version;
    setUpdate({ current: version });
    // Confere atualização uma vez ao abrir, sem atrapalhar o boot.
    setTimeout(checkUpdate, 5000);
    return { platform: 'android', profile: 'default', version };
  },
  flash: async () => {},
  notify: async (title, body) => {
    try {
      if ((await LocalNotifications.checkPermissions()).display !== 'granted') {
        if ((await LocalNotifications.requestPermissions()).display !== 'granted') return;
      }
      await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Math.random() * 2 ** 31), title, body }] });
    } catch {
      /* notificações indisponíveis */
    }
  },
  onChooseScreen: () => () => {},
  screenPicked: async () => {},
  interfaces: async () => [],
  hostStart: unsupported,
  hostStop: async () => noHost,
  hostStatus: async () => noHost,
  embedded: async () => null,
  exportConnector: unsupported,
  onExportProgress: () => () => {},
  updateStatus: async () => update,
  updateCheck: checkUpdate,
  updateDownload: async () => {
    // O navegador baixa o APK; tocar no download abre o instalador do Android.
    if (apkUrl) await DL.openUrl({ url: apkUrl });
  },
  updateInstall: async () => {},
  onUpdateStatus: (cb) => {
    updateListeners.add(cb);
    return () => updateListeners.delete(cb);
  },
  ...fileApi,
  fetchUrl,
  scheduleNotification: async (id, at, title, body) => {
    try {
      if ((await LocalNotifications.checkPermissions()).display !== 'granted') {
        if ((await LocalNotifications.requestPermissions()).display !== 'granted') return;
      }
      // id numérico estável a partir do ULID (o mesmo lembrete não agenda duas vezes).
      let h = 0;
      for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
      await LocalNotifications.schedule({ notifications: [{ id: Math.abs(h), title, body, schedule: { at: new Date(at), allowWhileIdle: true } }] });
    } catch {
      /* sem notificações */
    }
  },
  callActive: (active) => DL.callActive({ active }).catch(() => {}),
  setSpeaker: (on) => DL.setSpeaker({ on }),
};
