// Links do YouTube: extrair id/tempo e buscar o título (oEmbed, sem chave de API).

import { YT_ID_RE } from '../../shared/protocol.ts';
import { app } from './app.ts';

/** id = vídeo (pode faltar em link só de playlist); list = playlist/mix. */
export type YouTubeRef = { id: string | null; list: string | null; start: number };

const LIST_RE = /^[A-Za-z0-9_-]{10,64}$/;

function parseTime(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/** youtu.be/ID, youtube.com/watch?v=ID, /shorts/ID, /embed/ID, /live/ID, music.youtube.com… */
export function parseYouTube(text: string): YouTubeRef | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') ?? /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null;
  }
  if (host === 'youtube.com' && url.pathname === '/playlist') id = null;
  if (id && !YT_ID_RE.test(id)) id = null;
  const list = url.searchParams.get('list');
  const ref = { id, list: list && LIST_RE.test(list) ? list : null, start: parseTime(url.searchParams.get('t') ?? url.searchParams.get('start')) };
  return ref.id || ref.list ? ref : null;
}

export async function fetchTitle(id: string): Promise<string> {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return '';
    return String((await res.json()).title ?? '');
  } catch {
    return '';
  }
}

/**
 * Lista de vídeos de uma playlist/mix sem chave de API: um player escondido carrega
 * a playlist e a API do iframe devolve os ids (até ~200).
 */
export function playlistIds(list: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;border:0';
    f.allow = 'autoplay';
    f.src = `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(list)}&enablejsapi=1&autoplay=0&mute=1`;
    let settled = false;
    const finish = (err: Error | null, ids?: string[]) => {
      if (settled) return;
      settled = true;
      clearInterval(ping);
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      f.remove();
      if (err) reject(err);
      else resolve(ids!);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== f.contentWindow) return;
      let d: { event?: string; info?: { playlist?: unknown } | number };
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (d.event === 'onError') return finish(new Error('O YouTube não deixa tocar essa playlist fora do site (privada ou bloqueada).'));
      const pl = typeof d.info === 'object' ? d.info?.playlist : undefined;
      if (Array.isArray(pl) && pl.length) finish(null, pl.filter((x): x is string => typeof x === 'string' && YT_ID_RE.test(x)));
    };
    window.addEventListener('message', onMessage);
    const ping = window.setInterval(
      () => f.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'playlist', channel: 'widget' }), '*'),
      250,
    );
    const timeout = window.setTimeout(() => finish(new Error('Não consegui ler a playlist (privada, vazia ou sem internet).')), 15000);
    document.body.append(f);
  });
}

/** Títulos em lotes (oEmbed), avisando o progresso. */
async function titlesOf(ids: string[], onProgress?: (done: number, total: number) => void): Promise<string[]> {
  const out = new Array<string>(ids.length).fill('');
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      out[i] = await fetchTitle(ids[i]);
      onProgress?.(++done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

/** Põe o link na fila do bot da call atual (ou toca já, se nada estiver tocando). */
export async function queueYouTube(text: string, playNow = false): Promise<void> {
  const ref = parseYouTube(text);
  if (!ref?.id) {
    if (ref?.list) {
      await queuePlaylist(text, playNow);
      return;
    }
    throw new Error('Isso não parece um link de vídeo do YouTube');
  }
  const title = await fetchTitle(ref.id);
  await app.media({ type: 'add', video_id: ref.id, title, start: ref.start || undefined, play_now: playNow || undefined });
}

/** Playlist inteira (se o link aponta um vídeo dentro dela, começa por ele). */
export async function queuePlaylist(
  text: string,
  playNow = false,
  onProgress?: (msg: string) => void,
): Promise<number> {
  const ref = parseYouTube(text);
  if (!ref?.list) throw new Error('Esse link não tem playlist');
  if (!app.state.call) throw new Error('Entre numa call para usar o bot');
  onProgress?.('Lendo a playlist…');
  let ids = await playlistIds(ref.list);
  const at = ref.id ? ids.indexOf(ref.id) : -1;
  if (at > 0) ids = ids.slice(at);
  const titles = await titlesOf(ids, (d, t) => onProgress?.(`Buscando títulos… ${d}/${t}`));
  await app.media({ type: 'add_many', items: ids.map((video_id, i) => ({ video_id, title: titles[i] })), play_now: playNow || undefined });
  return ids.length;
}

export const thumb = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
