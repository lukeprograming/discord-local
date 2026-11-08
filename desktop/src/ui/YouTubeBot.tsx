// Bot de YouTube da call: cada um toca o vídeo no próprio app, seguindo o estado
// que o servidor guarda (fila, play/pausa, posição). Controle pelo nosso painel —
// o player do YouTube fica coberto para ninguém sair de sincronia clicando nele.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaState } from '../../../shared/protocol.ts';
import { app, useApp } from '../app.ts';
import { fetchTitle, mediaInfo, parseMedia, parseYouTube, queuePlaylist, queueYouTube, thumb, thumbOf } from '../youtube.ts';
import { useIdle, useTileFullscreen } from './tile.tsx';
import { createDriver, sourceLabel } from '../players.ts';

const FALLBACK_TITLES = ['Vídeo do YouTube', 'Faixa do SoundCloud', 'Música do Spotify'];
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
  const tile = useIdle();
  const full = useTileFullscreen('bot');

  // Diferença entre o relógio do servidor e o meu, medida quando o estado chegou.
  const offset = useMemo(() => media.server_time - Date.now(), [media]);
  const state = useRef({ media, offset });
  state.current = { media, offset };

  const expected = () => {
    const { media: m, offset: off } = state.current;
    return m.playing ? m.position + (Date.now() + off - m.updated_at) / 1000 : m.position;
  };
  const driver = useMemo(() => createDriver(item.source), [item.id]);
  const win = () => frame.current?.contentWindow ?? null;
  const [preview, setPreview] = useState(false);

  function sync() {
    const w = win();
    if (!ready.current || !w) return;
    const { media: m } = state.current;
    const exp = expected();
    const { currentTime: cur, playerState: st, duration: dur } = info.current;
    const isPreview = previewRef.current;
    // Spotify não tem volume: ensurdecido fica pausado só aqui.
    if (m.playing && deafRef.current && !driver.hasVolume) {
      if (st === 1) driver.pause(w);
      return;
    }
    if (m.playing) {
      // Erro/travado depois do fim: avisa que acabou (o servidor só avança uma vez).
      // Prévia de 30 s do Spotify não conta: quem está logado é que avisa o fim.
      if (!isPreview && dur > 0 && exp > dur + 4 && !ended.current) {
        ended.current = true;
        app.media({ type: 'ended', item_id: item.id }).catch(() => {});
        return;
      }
      if (isPreview && exp >= dur - 0.5) {
        if (st === 1) driver.pause(w);
        return;
      }
      if (Math.abs(cur - exp) > 2 && (!dur || exp < dur)) driver.seek(w, exp);
      if (st !== 1 && st !== 3 && st !== 0) driver.play(w);
    } else {
      if (st === 1 || st === 3) driver.pause(w);
      if (Math.abs(cur - exp) > 1) driver.seek(w, exp);
    }
  }
  const previewRef = useRef(false);
  const deafRef = useRef(deafened);
  deafRef.current = deafened;

  // Mensagens do player (postMessage do iframe de cada serviço).
  useEffect(() => {
    ready.current = false;
    ended.current = false;
    titleSent.current = false;
    previewRef.current = false;
    setPreview(false);
    info.current = { currentTime: 0, duration: 0, playerState: -1 };
    const onMessage = (e: MessageEvent) => {
      const w = win();
      if (!w || e.source !== w) return;
      const ev = driver.parse(e.data);
      if (!ev) return;
      if (ev.ready && !ready.current) {
        ready.current = true;
        driver.onReady?.(w);
        applyVolume();
        sync();
      }
      if (ev.error && !ended.current) {
        ended.current = true;
        app.toast(`${ev.error} — pulando.`);
        app.media({ type: 'ended', item_id: item.id }).catch(() => {});
      }
      if (typeof ev.time === 'number') info.current.currentTime = ev.time;
      if (typeof ev.duration === 'number' && ev.duration > 0) info.current.duration = ev.duration;
      if (ev.preview !== undefined && ev.preview !== previewRef.current) {
        previewRef.current = ev.preview;
        setPreview(ev.preview);
      }
      if (typeof ev.state === 'number') {
        info.current.playerState = ev.state;
        if (ev.state === 0 && !ended.current && !previewRef.current) {
          ended.current = true;
          app.media({ type: 'ended', item_id: item.id }).catch(() => {});
        }
      }
      if (ev.title && FALLBACK_TITLES.includes(item.title) && !titleSent.current) {
        titleSent.current = true;
        app.media({ type: 'title', item_id: item.id, title: ev.title }).catch(() => {});
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
    const w = win();
    if (w) driver.volume(w, volume, deafened);
  }
  useEffect(() => {
    if (ready.current) applyVolume();
    // Spotify não deixa mudar volume: ensurdecido = pausa só aqui.
    const w = win();
    if (w && ready.current && !driver.hasVolume && deafened) driver.pause(w);
  }, [volume, deafened]);

  // Handshake (YouTube): o player só manda estado depois de receber "listening".
  function onLoad() {
    if (!driver.handshake) return;
    let n = 0;
    const t = window.setInterval(() => {
      const w = win();
      if (w) driver.handshake!(w, item);
      if (ready.current || ++n > 40) clearInterval(t);
    }, 250);
  }

  const src = useMemo(() => driver.src(item, expected()), [item.id]);

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

  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
  const commitSeek = () => {
    if (seeking !== null) app.media({ type: 'seek', position: seeking }).catch(fail);
    setSeeking(null);
  };

  return (
    <div
      ref={tile.ref}
      className={`screen-tile bot-tile ${audioOnly ? 'audio-only' : ''} ${tile.idle && !audioOnly ? 'idle' : ''} ${full.fs ? 'tile-fs' : ''}`}
      onDoubleClick={() => !audioOnly && full.toggle()}
    >
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
        <div className="bot-shield" />
      </div>
      {preview && (
        <div className="preview-banner" onDoubleClick={(e) => e.stopPropagation()}>
          Você está ouvindo só a prévia de 30 s do Spotify.
          {window.native.spotifyLogin ? (
            <button className="mini" onClick={() => window.native.spotifyLogin!().then((ok) => ok && app.toast('Spotify conectado — a música inteira toca a partir da próxima.'))}>
              entrar no Spotify
            </button>
          ) : (
            <small> (no celular o Spotify toca só a prévia)</small>
          )}
        </div>
      )}
      {!audioOnly && (
        <div className="tile-top">
          <span className={`yt-badge src-${item.source ?? 'youtube'}`}>▶ {sourceLabel(item.source)}</span>
          <strong title={item.title}>{item.title}</strong>
          {media.queue.length > 1 && <small className="muted">+{media.queue.length - 1} na fila</small>}
        </div>
      )}
      <div className="player-controls" onDoubleClick={(e) => e.stopPropagation()}>
        {audioOnly && (
          <div className="player-now">
            <img className="bot-thumb" src={thumbOf(item)} alt="" />
            <div>
              <strong title={item.title}>{item.title}</strong>
              <small className="muted">{sourceLabel(item.source)} · por {app.user(item.added_by)?.display_name ?? '?'}{media.queue.length > 1 ? ` · +${media.queue.length - 1} na fila` : ''}</small>
            </div>
          </div>
        )}
        <div className="seek-wrap" style={{ '--pct': `${pct}%` } as React.CSSProperties}>
          <input
            className="seek"
            type="range"
            min={0}
            max={Math.max(1, Math.floor(dur))}
            step={1}
            value={Math.floor(cur)}
            disabled={!dur}
            onChange={(e) => setSeeking(Number(e.target.value))}
            onPointerUp={commitSeek}
            onKeyUp={commitSeek}
          />
        </div>
        <div className="player-row">
          <button
            className="pbtn big"
            title={media.playing ? 'Pausar para todos' : 'Tocar para todos'}
            onClick={() => app.media(media.playing ? { type: 'pause', position: expected() } : { type: 'play' }).catch(fail)}
          >
            {media.playing ? '❚❚' : '▶'}
          </button>
          <button className="pbtn" title="Próximo da fila" onClick={() => app.media({ type: 'next' }).catch(fail)}>
            ⏭
          </button>
          <span className="player-time">
            {fmt(cur)}
            {dur ? ` / ${fmt(dur)}` : ''}
          </span>
          <span className="player-spacer" />
          <label className="player-vol" title={`Volume só pra você: ${volume}%`}>
            <span onClick={() => app.saveSettings({ yt_volume: volume ? 0 : 60 })}>{volume === 0 || deafened ? '🔇' : volume < 50 ? '🔉' : '🔊'}</span>
            <input type="range" min={0} max={100} value={volume} onChange={(e) => app.saveSettings({ yt_volume: Number(e.target.value) })} />
          </label>
          <button className="pbtn" title={audioOnly ? 'Mostrar o vídeo' : 'Só o som (esconde o vídeo)'} onClick={toggleAudioOnly}>
            {audioOnly ? '🎬' : '🎧'}
          </button>
          {!audioOnly && (
            <button className="pbtn" title={full.fs ? 'Sair da tela cheia (Esc)' : 'Tela cheia (duplo clique; Esc sai)'} onClick={full.toggle}>
              {full.fs ? '🗙' : '⛶'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Painel do bot: adicionar link e mexer na fila. */
export function BotPanel({ media, onClose }: { media: MediaState | undefined; onClose: () => void }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const queue = media?.queue ?? [];
  const ref = parseYouTube(link);

  async function add(playNow: boolean, whole = false) {
    if (!link.trim()) return;
    setBusy(true);
    try {
      if (whole || (ref?.list && !ref.id)) {
        const n = await queuePlaylist(link, playNow, setProgress);
        app.toast(`Playlist: ${n} vídeos na fila`);
      } else {
        await queueYouTube(link, playNow);
      }
      setLink('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="bot-panel">
      <div className="bot-panel-head">
        <strong>🎵 Bot de música</strong>
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
          placeholder="Cole um link do YouTube, Spotify ou SoundCloud"
          onChange={(e) => setLink(e.target.value)}
        />
        <button type="submit" disabled={busy || !link.trim()}>
          {queue.length ? 'Pôr na fila' : 'Tocar'}
        </button>
        {queue.length > 0 && (
          <button type="button" disabled={busy || !link.trim()} onClick={() => add(true)} title={ref?.list && !ref.id ? 'Troca a fila pela playlist' : undefined}>
            Tocar agora
          </button>
        )}
      </form>
      {ref?.list && ref.id && (
        <div className="bot-playlist">
          <small className="muted">Esse link é de um vídeo dentro de uma playlist.</small>
          <button type="button" className="mini" disabled={busy} onClick={() => add(false, true)}>
            ➕ playlist inteira na fila
          </button>
          <button type="button" className="mini" disabled={busy} onClick={() => add(true, true)} title="Troca a fila atual pela playlist">
            ▶ tocar a playlist agora
          </button>
        </div>
      )}
      {progress && <small className="muted">{progress}</small>}
      {ref?.id && <LinkPreviewYT id={ref.id} />}
      {parseMedia(link) && <LinkPreviewOther text={link} />}
      {queue.length > 0 && (
        <>
          <div className="now-card">
            <img src={thumbOf(queue[0])} alt="" />
            <div>
              <small className="muted">{media?.playing ? '▶ tocando agora' : '❚❚ pausado'}</small>
              <strong title={queue[0].title}>{queue[0].title}</strong>
              <small className="muted">por {app.user(queue[0].added_by)?.display_name ?? '?'}</small>
            </div>
            <button className="mini" title="Pular" onClick={() => app.media({ type: 'next' }).catch(fail)}>⏭</button>
          </div>
          {queue.length > 1 && <h5 className="queue-title">A seguir ({queue.length - 1})</h5>}
          <ol className="bot-queue">
            {queue.slice(1).map((it, i) => (
              <li key={it.id}>
                <span className="queue-n">{i + 1}</span>
                <img src={thumbOf(it)} alt="" />
                <div>
                  <span title={it.title}>{it.title}</span>
                  <small className="muted">por {app.user(it.added_by)?.display_name ?? '?'}</small>
                </div>
                <button className="mini" title="Tocar agora" onClick={() => app.media({ type: 'jump', id: it.id }).catch(fail)}>
                  ▶
                </button>
                <button className="mini" title="Tirar da fila" onClick={() => app.media({ type: 'remove', id: it.id }).catch(fail)}>
                  ✕
                </button>
              </li>
            ))}
          </ol>
          <div className="bot-queue-actions">
            <small className="muted">{queue.length} na fila</small>
            {queue.length > 2 && (
              <button className="link" onClick={() => app.media({ type: 'shuffle' }).catch(fail)}>
                🔀 embaralhar
              </button>
            )}
            <button className="link" onClick={() => app.media({ type: 'clear' }).catch(fail)}>
              Parar e limpar a fila
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Prévia do link colado (antes de pôr na fila). */
function LinkPreviewYT({ id }: { id: string }) {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setTitle(null);
    fetchTitle(id).then((t) => alive && setTitle(t || 'Vídeo do YouTube'));
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <div className="link-yt">
      <img src={thumb(id)} alt="" />
      <span>{title ?? 'buscando título…'}</span>
    </div>
  );
}

function LinkPreviewOther({ text }: { text: string }) {
  const [info, setInfo] = useState<{ title: string; thumb: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const l = parseMedia(text);
    setInfo(null);
    if (l) mediaInfo(l).then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [text]);
  const l = parseMedia(text);
  return (
    <div className="link-yt">
      {info?.thumb ? <img src={info.thumb} alt="" /> : <span className="link-src">{l?.source === 'spotify' ? '🟢' : '🟠'}</span>}
      <span>
        {info ? info.title || 'sem título' : 'buscando…'} <small className="muted">· {sourceLabel(l?.source)}</small>
      </span>
    </div>
  );
}
