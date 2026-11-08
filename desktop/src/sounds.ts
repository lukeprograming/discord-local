// Soundboard: os sons ficam no host (POST/GET /sounds); cada um toca no próprio app.

import { MAX_SOUND_BYTES } from '../../shared/protocol.ts';
import { app } from './app.ts';

const cache = new Map<string, Promise<string>>(); // id -> blob: URL

function session() {
  const p = app.state.profile;
  if (!p) throw new Error('sem sessão');
  return { url: p.server_url.replace(/\/$/, ''), token: p.token };
}

function load(id: string): Promise<string> {
  let p = cache.get(id);
  if (!p) {
    const { url, token } = session();
    p = fetch(`${url}/sounds/${id}`, { headers: { authorization: `Bearer ${token}` } }).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return URL.createObjectURL(await r.blob());
    });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** Toca o som aqui (quando alguém da call apertou). */
export async function playSound(id: string): Promise<void> {
  const src = await load(id);
  const audio = new Audio(src) as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  const s = app.state.profile?.settings;
  audio.volume = Math.max(0, Math.min(1, (s?.sound_volume ?? 60) / 100));
  if (s?.speaker_id) await audio.setSinkId?.(s.speaker_id).catch(() => {});
  await audio.play();
}

/** Prévia só pra mim (não manda pra call). */
export const previewSound = playSound;

export async function uploadSound(file: File, name: string, emoji: string): Promise<void> {
  if (file.size > MAX_SOUND_BYTES) throw new Error('Som grande demais (máx. 1 MB — corte pra poucos segundos).');
  const { url, token } = session();
  const q = new URLSearchParams({ name, emoji });
  const r = await fetch(`${url}/sounds?${q}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': file.type || 'audio/mpeg' },
    body: file,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
}
