// Gravação da call, clipes ("replay" dos últimos segundos) e transmitir um arquivo de vídeo.
// Só desktop: os pedaços do MediaRecorder vão direto pro disco pelo processo principal.

import { useSyncExternalStore } from 'react';
import { app } from './app.ts';
import type { ScreenPreset } from './rtc.ts';

// ---- estado observável (pra UI) ----

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
export function useRecorder() {
  useSyncExternalStore(subscribe, () => version);
  return {
    recording: rec && { label: rec.label, startedAt: rec.startedAt },
    clip: replay && { label: replay.label, since: replay.since },
    lastClip,
    lastRecording,
    video: video && { el: video.el, name: video.name },
  };
}

function pickMime(withVideo: boolean): string {
  const list = withVideo
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm'];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

export const canRecord = () => !!window.native.recStart && typeof MediaRecorder !== 'undefined';

/** Alvo de gravação/clipe: a tela de alguém (vídeo) ou só o áudio da call. */
export type Target = { label: string; stream: MediaStream | null };

// ---- gravação ----

let rec: { mr: MediaRecorder; label: string; startedAt: number } | null = null;
let lastRecording: string | null = null;

export function isRecording(): boolean {
  return !!rec;
}

export async function startRecording(target: Target): Promise<void> {
  const call = app.state.call;
  if (!call || rec || !canRecord()) return;
  const mix = call.mixForRecording();
  const videoTracks = target.stream?.getVideoTracks() ?? [];
  const stream = new MediaStream([...mix.getAudioTracks(), ...videoTracks]);
  const mimeType = pickMime(videoTracks.length > 0);
  let file: { id: string; path: string };
  try {
    file = await window.native.recStart!('gravacao', 'webm');
  } catch (e) {
    call.stopMixForRecording();
    throw e;
  }
  const mr = new MediaRecorder(stream, { ...(mimeType && { mimeType }), videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 });
  let chain = Promise.resolve();
  mr.ondataavailable = (e) => {
    if (!e.data.size) return;
    chain = chain.then(async () => window.native.recWrite!(file.id, new Uint8Array(await e.data.arrayBuffer()))).catch((err) => {
      console.error('[rec] gravar', err);
    });
  };
  mr.onstop = async () => {
    await chain;
    lastRecording = await window.native.recFinish!(file.id);
    call.stopMixForRecording();
    rec = null;
    bump();
    app.recordingChanged();
    app.toast('Gravação salva (veja em ⏺ → mostrar na pasta).');
  };
  // A pessoa parou de transmitir: encerra a gravação (o arquivo fica com o que deu).
  for (const t of videoTracks) t.addEventListener('ended', () => stopRecording());
  mr.start(1000);
  rec = { mr, label: target.label, startedAt: Date.now() };
  bump();
  app.recordingChanged();
}

export function stopRecording(): void {
  if (rec && rec.mr.state !== 'inactive') rec.mr.stop();
}

// ---- clipes: dois gravadores defasados; o mais antigo tem sempre entre 30 e 60 s ----

const SEGMENT_MS = 60_000;

type Segment = { mr: MediaRecorder; chunks: Blob[]; startedAt: number };

let replay: { label: string; since: number; stream: MediaStream; segs: Segment[]; timers: number[]; stopMix: () => void } | null = null;
let lastClip: { path: string; blob: Blob; name: string } | null = null;

export function clipBufferOn(): boolean {
  return !!replay;
}

export function startClipBuffer(target: Target): void {
  const call = app.state.call;
  if (!call || !canRecord()) return;
  stopClipBuffer();
  const mix = call.mixForRecording();
  const videoTracks = target.stream?.getVideoTracks() ?? [];
  const stream = new MediaStream([...mix.getAudioTracks(), ...videoTracks]);
  const mimeType = pickMime(videoTracks.length > 0);
  const r = {
    label: target.label,
    since: Date.now(),
    stream,
    segs: [] as Segment[],
    timers: [] as number[],
    stopMix: () => call.stopMixForRecording(),
  };
  const spawn = () => {
    if (replay !== r) return;
    const seg: Segment = {
      mr: new MediaRecorder(stream, { ...(mimeType && { mimeType }), videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 }),
      chunks: [],
      startedAt: Date.now(),
    };
    seg.mr.ondataavailable = (e) => e.data.size && seg.chunks.push(e.data);
    seg.mr.start(1000);
    r.segs.push(seg);
    // Renasce depois de 60 s (o outro, 30 s mais novo, cobre o buraco).
    r.timers.push(
      window.setTimeout(() => {
        r.segs = r.segs.filter((x) => x !== seg);
        if (seg.mr.state !== 'inactive') seg.mr.stop();
        spawn();
      }, SEGMENT_MS),
    );
  };
  replay = r;
  spawn();
  r.timers.push(window.setTimeout(spawn, SEGMENT_MS / 2));
  for (const t of videoTracks) t.addEventListener('ended', () => replay === r && stopClipBuffer());
  bump();
}

export function stopClipBuffer(): void {
  const r = replay;
  if (!r) return;
  replay = null;
  for (const t of r.timers) clearTimeout(t);
  for (const s of r.segs) if (s.mr.state !== 'inactive') s.mr.stop();
  r.stopMix();
  bump();
}

/** Salva o clipe (30–60 s mais recentes). */
export async function saveClip(): Promise<void> {
  const r = replay;
  if (!r) throw new Error('Ligue "guardar clipes" no botão ⏺ da call primeiro.');
  const seg = [...r.segs].sort((a, b) => a.startedAt - b.startedAt)[0];
  if (!seg || Date.now() - seg.startedAt < 3000) throw new Error('Ainda não deu tempo de guardar nada.');
  // Pede o pedaço que está no meio do caminho, pra o clipe ir até agora.
  await new Promise<void>((resolve) => {
    const prev = seg.mr.ondataavailable;
    seg.mr.ondataavailable = (e) => {
      prev?.call(seg.mr, e);
      seg.mr.ondataavailable = prev;
      resolve();
    };
    seg.mr.requestData();
    setTimeout(resolve, 1500);
  });
  const blob = new Blob(seg.chunks, { type: seg.mr.mimeType || 'video/webm' });
  const file = await window.native.recStart!('clipe', 'webm');
  await window.native.recWrite!(file.id, new Uint8Array(await blob.arrayBuffer()));
  const path = (await window.native.recFinish!(file.id)) ?? file.path;
  const secs = Math.round((Date.now() - seg.startedAt) / 1000);
  lastClip = { path, blob, name: path.split(/[\\/]/).pop() ?? 'clipe.webm' };
  bump();
  app.toast(`Clipe salvo (${secs} s) — dá pra mandar no chat pelo botão ⏺.`);
}

// ---- transmitir um arquivo de vídeo do PC ----

let video: { el: HTMLVideoElement; url: string; name: string } | null = null;

export async function startVideoFile(file: File, preset: ScreenPreset): Promise<void> {
  const call = app.state.call;
  if (!call) return;
  const el = document.createElement('video');
  const url = URL.createObjectURL(file);
  el.src = url;
  el.playsInline = true;
  el.className = 'video-share-source';
  el.volume = Math.max(0, Math.min(1, (app.state.profile?.settings?.video_share_volume ?? 50) / 100));
  document.body.append(el);
  try {
    await el.play();
  } catch (e) {
    el.remove();
    URL.revokeObjectURL(url);
    throw new Error(`Não consegui tocar esse vídeo (${(e as Error).message}). Formatos que funcionam: mp4 (H.264), webm, mkv com VP9/AV1.`);
  }
  const stream = (el as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
  const mine = { el, url, name: file.name };
  video = mine;
  await call.startCustomScreen(stream, preset, 'motion', () => {
    if (video !== mine) return;
    el.pause();
    el.remove();
    URL.revokeObjectURL(url);
    video = null;
    bump();
  });
  bump();
}

export function setVideoVolume(v: number): void {
  if (video) video.el.volume = Math.max(0, Math.min(1, v / 100));
}

/** Saiu da call: para tudo. */
export function stopAllRecording(): void {
  stopRecording();
  stopClipBuffer();
}
