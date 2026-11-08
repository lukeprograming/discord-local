// Bot de YouTube da call: cada um toca o vídeo no próprio app, seguindo o estado
// que o servidor guarda (fila, play/pausa, posição). Controle pelo nosso painel —
// o player do YouTube fica coberto para ninguém sair de sincronia clicando nele.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaState } from '../../../shared/protocol.ts';
import { app, useApp } from '../app.ts';
import { queueYouTube, thumb } from '../youtube.ts';

const FALLBACK_TITLE = 'Vídeo do YouTube';
const fail = (e: unknown) => app.toast((e as Error).message);

type Info = { currentTime: number; duration: number; playerState: number };

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Tile do player (vai junto com as telas transmitidas). */
export function BotPlayer({ media }: { media: MediaState }) {
  const item = media.queue[0];
  const volume = useApp((s) => s.profile?.settings?.yt_volume ?? 60);
  const deafened = useApp((s) => !!s.call?.deafened);
  const [audioOnly, setAudioOnly] = useState(() => {
    try {
      return localStorage.getItem('yt-audio-only') === '1';
    } catch {
      return false;
    }
  });
  const frame = useRef<HTMLIFrameElement>(null);
  const info = useRef<Info>({ currentTime: 0, duration: 0, playerState: -1 });
  const ready = useRef(false);
  const ended = useRef(false);
  const titleSent = useRef(false);
  const [, redraw] = useState(0);
  const [seeking, setSeeking] = useState<number | null>(null);

  // Diferença entre o relógio do servidor e o meu, medida quando o estado chegou.
  const offset = useMemo(() => media.server_time - Date.now(), [media]);
  const state = useRef({ media, offset });
  state.current = { media, offset };

  const expected = () => {
    const { media: m, offset: off } = state.current;
    return m.playing ? m.position + (Date.now() + off - m.updated_at) / 1000 : m.position;
  };
  const cmd = (func: string, args: unknown[] = []) =>
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*');

  function sync() {
    if (!ready.current) return;
    const { media: m } = state.current;
    const exp = expected();
    const { currentTime: cur, playerState: st, duration: dur } = info.current;
    if (m.playing) {
      // Erro/vídeo travado depois do fim: avisa que acabou (o servidor só avança uma vez).
      if (dur > 0 && exp > dur + 4 && !ended.current) {
        ended.current = true;
        app.media({ type: 'ended', item_id: item.id }).catch(() => {});
        return;
      }
      if (Math.abs(cur - exp) > 2 && (!dur || exp < dur)) cmd('seekTo', [exp, true]);
      if (st !== 1 && st !== 3 && st !== 0) cmd('playVideo');
    } else {
      if (st === 1 || st === 3) cmd('pauseVideo');
      if (Math.abs(cur - exp) > 1) cmd('seekTo', [exp, true]);
    }
  }

  // Mensagens do player (postMessage da API do iframe).
  useEffect(() => {
    ready.current = false;
    ended.current = false;
    titleSent.current = false;
    info.current = { currentTime: 0, duration: 0, playerState: -1 };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      let d: { event?: string; info?: Record<string, unknown> | number };
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if ((d.event === 'onReady' || d.event === 'initialDelivery') && !ready.current) {
        ready.current = true;
        applyVolume();
        sync();
      }
      if (d.event === 'onError' && !ended.current) {
        ended.current = true;
        app.toast('Esse vídeo não pode tocar fora do YouTube — pulando.');
        app.media({ type: 'ended', item_id: item.id }).catch(() => {});
      }
      if (d.event === 'infoDelivery' && d.info && typeof d.info === 'object') {
        const i = d.info as { currentTime?: number; duration?: number; playerState?: number; videoData?: { title?: string } };
        if (typeof i.currentTime === 'number') info.current.currentTime = i.currentTime;
        if (typeof i.duration === 'number') info.current.duration = i.duration;
        if (typeof i.playerState === 'number') {
          info.current.playerState = i.playerState;
          if (i.playerState === 0 && !ended.current) {
            ended.current = true;
            app.media({ type: 'ended', item_id: item.id }).catch(() => {});
          }
        }
        const t = i.videoData?.title;
        if (t && item.title === FALLBACK_TITLE && !titleSent.current) {
          titleSent.current = true;
          app.media({ type: 'title', item_id: item.id, title: t }).catch(() => {});
        }
      }
    };
    window.addEventListener('message', onMessage);
    const timer = window.setInterval(sync, 1000);
    const paint = window.setInterval(() => redraw((n) => n + 1), 500);
    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
      clearInterval(paint);
    };
  }, [item.id]);

  useEffect(sync, [media]);

  function applyVolume() {
    cmd('setVolume', [volume]);
    cmd(deafened || volume === 0 ? 'mute' : 'unMute');
  }
  useEffect(() => {
    if (ready.current) applyVolume();
  }, [volume, deafened]);

  // Handshake da API: o player só manda estado depois de receber "listening".
  function onLoad() {
    let n = 0;
    const t = window.setInterval(() => {
      frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: item.id, channel: 'widget' }), '*');
      if (ready.current || ++n > 40) clearInterval(t);
    }, 250);
  }

  const src = useMemo(() => {
    const p = new URLSearchParams({
      enablejsapi: '1',
      autoplay: '1',
      playsinline: '1',
      controls: '0',
      disablekb: '1',
      rel: '0',
      iv_load_policy: '3',
      start: String(Math.floor(expected())),
    });
    return `https://www.youtube-nocookie.com/embed/${item.video_id}?${p}`;
  }, [item.id]);

  const dur = info.current.duration;
  const cur = seeking ?? Math.min(expected(), dur || Infinity);

  function toggleAudioOnly() {
    const v = !audioOnly;
    setAudioOnly(v);
    try {
      localStorage.setItem('yt-audio-only', v ? '1' : '0');
    } catch {
      /* sem storage */
    }
  }

  return (
    <div className={`screen-tile bot-tile ${audioOnly ? 'audio-only' : ''}`}>
      <div className="bot-video">
        <iframe
          key={item.id}
          ref={frame}
          src={src}
          title="YouTube"
          allow="autoplay; encrypted-media"
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={onLoad}
        />
        <div className="bot-shield" onDoubleClick={() => app.setStage(app.state.stage === 'normal' ? 'theater' : 'normal')} />
      </div>
      <div className="bot-bar">
        {audioOnly && <img className="bot-thumb" src={thumb(item.video_id)} alt="" />}
        <button
          className="mini"
          title={media.playing ? 'Pausar para todos' : 'Tocar para todos'}
          onClick={() => app.media(media.playing ? { type: 'pause', position: expected() } : { type: 'play' }).catch(fail)}
        >
          {media.playing ? '❚❚' : '▶'}
        </button>
        <button className="mini" title="Próximo da fila" onClick={() => app.media({ type: 'next' }).catch(fail)}>
          ⏭
        </button>
        <span className="bot-title" title={item.title}>
          🎵 {item.title}
        </span>
        <small className="bot-time">
          {fmt(cur)}
          {dur ? ` / ${fmt(dur)}` : ''}
        </small>
        <input
          className="bot-seek"
          type="range"
          min={0}
          max={Math.max(1, Math.floor(dur))}
          step={1}
          value={Math.floor(cur)}
          disabled={!dur}
          onChange={(e) => setSeeking(Number(e.target.value))}
          onPointerUp={() => {
            if (seeking !== null) app.media({ type: 'seek', position: seeking }).catch(fail);
            setSeeking(null);
          }}
          onKeyUp={() => {
            if (seeking !== null) app.media({ type: 'seek', position: seeking }).catch(fail);
            setSeeking(null);
          }}
        />
        <input
          className="bot-volume"
          type="range"
          min={0}
          max={100}
          value={volume}
          title={`Volume só pra você: ${volume}%`}
          onChange={(e) => app.saveSettings({ yt_volume: Number(e.target.value) })}
        />
        <button className="mini" title={audioOnly ? 'Mostrar o vídeo' : 'Só o som (esconde o vídeo)'} onClick={toggleAudioOnly}>
          {audioOnly ? '🎬' : '🎧'}
        </button>
      </div>
    </div>
  );
}

/** Painel do bot: adicionar link e mexer na fila. */
export function BotPanel({ media, onClose }: { media: MediaState | undefined; onClose: () => void }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const queue = media?.queue ?? [];

  async function add(playNow: boolean) {
    if (!link.trim()) return;
    setBusy(true);
    try {
      await queueYouTube(link, playNow);
      setLink('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bot-panel">
      <div className="bot-panel-head">
        <strong>🎵 Bot do YouTube</strong>
        <small className="muted">todos na call ouvem/assistem juntos</small>
        <button className="icon" title="Fechar" onClick={onClose}>✕</button>
      </div>
      <form
        className="bot-add"
        onSubmit={(e) => {
          e.preventDefault();
          add(false);
        }}
      >
        <input
          autoFocus
          value={link}
          placeholder="Cole um link do YouTube (vídeo ou música)"
          onChange={(e) => setLink(e.target.value)}
        />
        <button type="submit" disabled={busy || !link.trim()}>
          {queue.length ? 'Pôr na fila' : 'Tocar'}
        </button>
        {queue.length > 0 && (
          <button type="button" disabled={busy || !link.trim()} onClick={() => add(true)}>
            Tocar agora
          </button>
        )}
      </form>
      {queue.length > 0 && (
        <>
          <ol className="bot-queue">
            {queue.map((it, i) => (
              <li key={it.id} className={i === 0 ? 'now' : ''}>
                <img src={thumb(it.video_id)} alt="" />
                <div>
                  <span title={it.title}>{it.title}</span>
                  <small className="muted">
                    {i === 0 ? (media?.playing ? 'tocando' : 'pausado') : `#${i}`} · por {app.user(it.added_by)?.display_name ?? '?'}
                  </small>
                </div>
                {i > 0 && (
                  <button className="mini" title="Tocar agora" onClick={() => app.media({ type: 'jump', id: it.id }).catch(fail)}>
                    ▶
                  </button>
                )}
                <button className="mini" title="Tirar da fila" onClick={() => app.media({ type: 'remove', id: it.id }).catch(fail)}>
                  ✕
                </button>
              </li>
            ))}
          </ol>
          <button className="link" onClick={() => app.media({ type: 'clear' }).catch(fail)}>
            Parar e limpar a fila
          </button>
        </>
      )}
    </div>
  );
}
