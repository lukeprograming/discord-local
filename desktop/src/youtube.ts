// Links do YouTube: extrair id/tempo e buscar o título (oEmbed, sem chave de API).

import { YT_ID_RE } from '../../shared/protocol.ts';
import { app } from './app.ts';

export type YouTubeRef = { id: string; start: number };

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
  if (!id || !YT_ID_RE.test(id)) return null;
  return { id, start: parseTime(url.searchParams.get('t') ?? url.searchParams.get('start')) };
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

/** Põe o link na fila do bot da call atual (ou toca já, se nada estiver tocando). */
export async function queueYouTube(text: string, playNow = false): Promise<void> {
  const ref = parseYouTube(text);
  if (!ref) throw new Error('Isso não parece um link de vídeo do YouTube');
  const title = await fetchTitle(ref.id);
  await app.media({ type: 'add', video_id: ref.id, title, start: ref.start || undefined, play_now: playNow || undefined });
}

export const thumb = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
