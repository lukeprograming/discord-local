// "Motores" do bot de música: cada serviço tem seu player embutido com um jeito
// próprio de receber comandos (postMessage). O BotPlayer só fala com esta interface.
//
// Estados no padrão do YouTube: -1 sem começar, 0 acabou, 1 tocando, 2 pausado, 3 carregando.

import type { MediaItem, MediaSource } from '../../shared/protocol.ts';

export type PlayerEvent = {
  ready?: boolean;
  time?: number; // segundos
  duration?: number; // segundos
  state?: number;
  title?: string;
  error?: string;
  /** Spotify sem login: só a prévia de 30 s. */
  preview?: boolean;
};

export type Driver = {
  src(item: MediaItem, start: number): string;
  /** Repetido a cada 250 ms até o player ficar pronto. */
  handshake?(win: Window, item: MediaItem): void;
  onReady?(win: Window): void;
  parse(data: unknown): PlayerEvent | null;
  play(win: Window): void;
  pause(win: Window): void;
  seek(win: Window, sec: number): void;
  volume(win: Window, v: number, muted: boolean): void;
  /** Dá pra controlar volume pelo app? (Spotify não deixa.) */
  hasVolume: boolean;
};

const asObj = (d: unknown): Record<string, unknown> | null => {
  try {
    const v = typeof d === 'string' ? JSON.parse(d) : d;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

function youtube(): Driver {
  const cmd = (w: Window, func: string, args: unknown[] = []) => w.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
  return {
    hasVolume: true,
    src: (item, start) =>
      `https://www.youtube-nocookie.com/embed/${item.video_id}?${new URLSearchParams({
        enablejsapi: '1',
        autoplay: '1',
        playsinline: '1',
        controls: '0',
        disablekb: '1',
        rel: '0',
        iv_load_policy: '3',
        start: String(Math.floor(start)),
      })}`,
    handshake: (w, item) => w.postMessage(JSON.stringify({ event: 'listening', id: item.id, channel: 'widget' }), '*'),
    parse(data) {
      const d = asObj(data);
      if (!d) return null;
      if (d.event === 'onReady' || d.event === 'initialDelivery') return { ready: true };
      if (d.event === 'onError') return { error: 'Esse vídeo não pode tocar fora do YouTube' };
      if (d.event !== 'infoDelivery' || !d.info || typeof d.info !== 'object') return null;
      const i = d.info as { currentTime?: number; duration?: number; playerState?: number; videoData?: { title?: string } };
      return { time: i.currentTime, duration: i.duration, state: i.playerState, title: i.videoData?.title };
    },
    play: (w) => cmd(w, 'playVideo'),
    pause: (w) => cmd(w, 'pauseVideo'),
    seek: (w, s) => cmd(w, 'seekTo', [s, true]),
    volume(w, v, muted) {
      cmd(w, 'setVolume', [v]);
      cmd(w, muted || v === 0 ? 'mute' : 'unMute');
    },
  };
}

function soundcloud(): Driver {
  const send = (w: Window, method: string, value?: unknown) => w.postMessage(JSON.stringify(value === undefined ? { method } : { method, value }), '*');
  let duration = 0;
  return {
    hasVolume: true,
    src: (item) =>
      `https://w.soundcloud.com/player/?${new URLSearchParams({
        url: item.url ?? '',
        auto_play: 'true',
        visual: 'true',
        hide_related: 'true',
        show_comments: 'false',
        show_reposts: 'false',
        show_teaser: 'false',
        show_user: 'true',
      })}`,
    onReady(w) {
      for (const ev of ['playProgress', 'play', 'pause', 'finish', 'error']) send(w, 'addEventListener', ev);
      send(w, 'getDuration');
    },
    parse(data) {
      const d = asObj(data);
      if (!d || typeof d.method !== 'string') return null;
      const v = d.value as { currentPosition?: number } | number | null;
      switch (d.method) {
        case 'ready':
          return { ready: true };
        case 'getDuration':
          if (typeof v === 'number' && v > 0) duration = v / 1000;
          return { duration };
        case 'playProgress':
          return { state: 1, time: typeof v === 'object' && v?.currentPosition !== undefined ? v.currentPosition / 1000 : undefined, duration: duration || undefined };
        case 'play':
          return { state: 1 };
        case 'pause':
          return { state: 2 };
        case 'finish':
          return { state: 0 };
        case 'error':
          return { error: 'Essa faixa do SoundCloud não pode tocar fora do site' };
      }
      return null;
    },
    play: (w) => {
      send(w, 'play');
      if (!duration) send(w, 'getDuration');
    },
    pause: (w) => send(w, 'pause'),
    seek: (w, s) => send(w, 'seekTo', Math.max(0, Math.round(s * 1000))),
    volume: (w, v, muted) => send(w, 'setVolume', muted ? 0 : v),
  };
}

function spotify(): Driver {
  let started = false;
  let lastPos = 0;
  let lastDur = 0;
  let wasPlaying = false;
  return {
    hasVolume: false,
    src: (item) => `https://open.spotify.com/embed/track/${item.video_id}?utm_source=discord-local&theme=0`,
    parse(data) {
      const d = asObj(data);
      if (!d || typeof d.type !== 'string') return null;
      if (d.type === 'ready') return { ready: true };
      if (d.type !== 'playback_update' || !d.payload || typeof d.payload !== 'object') return null;
      const p = d.payload as { isPaused?: boolean; isBuffering?: boolean; duration?: number; position?: number };
      const pos = (p.position ?? 0) / 1000;
      const dur = (p.duration ?? 0) / 1000;
      // Fim: estava tocando perto do final e parou (o embed volta pro começo).
      let state = p.isBuffering ? 3 : p.isPaused ? 2 : 1;
      if (wasPlaying && p.isPaused && lastDur > 0 && lastPos >= lastDur - 1.5) state = 0;
      wasPlaying = !p.isPaused;
      lastPos = pos;
      lastDur = dur;
      return { time: pos, duration: dur, state, preview: dur > 0 && dur <= 31 };
    },
    play: (w) => {
      w.postMessage({ command: started ? 'resume' : 'play' }, '*');
      started = true;
    },
    pause: (w) => w.postMessage({ command: 'pause' }, '*'),
    seek: (w, s) => w.postMessage({ command: 'seek', timestamp: Math.max(0, Math.floor(s)) }, '*'),
    volume: () => {},
  };
}

export function createDriver(source: MediaSource | undefined): Driver {
  return source === 'soundcloud' ? soundcloud() : source === 'spotify' ? spotify() : youtube();
}

export function sourceLabel(source: MediaSource | undefined): string {
  return source === 'soundcloud' ? 'SoundCloud' : source === 'spotify' ? 'Spotify' : 'YouTube';
}
