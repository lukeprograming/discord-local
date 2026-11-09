// Bot de música da call: cada um toca o vídeo no próprio app, seguindo o estado
// que o servidor guarda (fila, play/pausa, posição).
//
// O motor (iframe + sincronia) fica montado no nível do app enquanto a call em que
// estou tiver fila: trocar de conversa não para a música. O vídeo aparece por cima
// do "slot" que o palco da call desenha (#media-slot); sem slot, o iframe continua
// tocando fora da tela. O player do rodapé (PlayerBar) controla tudo.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Headphones, ListMusic, Maximize2, Minimize2, Pause, Play, Shuffle, SkipForward, Video, Volume1, Volume2, VolumeX } from 'lucide-react';
import type { MediaState } from '../../../shared/protocol.ts';
import { app, useApp } from '../app.ts';
import { thumbOf } from '../youtube.ts';
import { useIdle, useTileFullscreen } from './tile.tsx';
import { createDriver, sourceLabel } from '../players.ts';

const FALLBACK_TITLES = ['Vídeo do YouTube', 'Faixa do SoundCloud', 'Música do Spotify'];
const fail = (e: unknown) => app.toast((e as Error).message);

export function fmt(sec: number): string {
  if (!Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---- relógio compartilhado entre o motor, o rodapé e o palco ----

type Clock = { dur: number; preview: boolean; video: boolean; tick: number };

function loadVideo(): boolean {
  try {
    return localStorage.getItem('yt-audio-only') !== '1';
  } catch {
    return true;
  }
}

let clock: Clock = { dur: 0, preview: false, video: loadVideo(), tick: 0 };
let expectedFn: () => number = () => 0;
const clockListeners = new Set<() => void>();
function setClock(patch: Partial<Clock>): void {
  clock = { ...clock, ...patch };
  clockListeners.forEach((l) => l());
}
function useClock(): Clock {
  return useSyncExternalStore(
    (l) => {
      clockListeners.add(l);
      return () => clockListeners.delete(l);
    },
    () => clock,
  );
}

/** Mostrar o vídeo no palco (senão só o som, controlado pelo rodapé). */
export function useMediaVideo(): boolean {
  return useClock().video;
}

function setVideo(v: boolean): void {
  setClock({ video: v });
  try {
    localStorage.setItem('yt-audio-only', v ? '0' : '1');
  } catch {
    /* sem storage */
  }
}

/** Mídia da call em que estou (ou nada). */
function useMyMedia(): MediaState | undefined {
  return useApp((s) => (s.call ? s.calls[s.call.conversationId]?.media : undefined));
}

// ---- motor ----

export function MediaEngine() {
  const media = useMyMedia();
  if (!media?.queue.length) return null;
  return <Engine media={media} />;
}

type Info = { currentTime: number; duration: number; playerState: number };

function Engine({ media }: { media: MediaState }) {
  const item = media.queue[0];
  const volume = useApp((s) => s.profile?.settings?.yt_volume ?? 60);
  const deafened = useApp((s) => !!s.call?.deafened);
  const { video, preview } = useClock();
  const frame = useRef<HTMLIFrameElement>(null);
  const info = useRef<Info>({ currentTime: 0, duration: 0, playerState: -1 });
  const ready = useRef(false);
  const ended = useRef(false);
  const titleSent = useRef(false);
  const previewRef = useRef(false);
  const deafRef = useRef(deafened);
  deafRef.current = deafened;
  const tile = useIdle();
  const full = useTileFullscreen('bot');
  const [shown, setShown] = useState(false);

  // Diferença entre o relógio do servidor e o meu, medida quando o estado chegou.
  const offset = useMemo(() => media.server_time - Date.now(), [media]);
  const state = useRef({ media, offset });
  state.current = { media, offset };

  const expected = () => {
    const { media: m, offset: off } = state.current;
    return m.playing ? m.position + (Date.now() + off - m.updated_at) / 1000 : m.position;
  };
  expectedFn = expected;
  const driver = useMemo(() => createDriver(item.source), [item.id]);
  const win = () => frame.current?.contentWindow ?? null;

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

  // Mensagens do player (postMessage do iframe de cada serviço).
  useEffect(() => {
    ready.current = false;
    ended.current = false;
    titleSent.current = false;
    previewRef.current = false;
    setClock({ preview: false, dur: 0 });
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
        setClock({ preview: ev.preview });
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
    const paint = window.setInterval(() => setClock({ dur: info.current.duration, tick: clock.tick + 1 }), 500);
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

  // Posição: por cima do slot do palco, em tela cheia, ou fora da tela (tocando só o som).
  const placement = useRef({ video, fs: full.fs });
  placement.current = { video, fs: full.fs };
  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      const el = tile.ref.current;
      if (el) {
        const { video: v, fs } = placement.current;
        const slot = v && !fs ? document.getElementById('media-slot') : null;
        const r = slot?.getBoundingClientRect();
        const key = fs ? 'fs' : r && r.width > 0 && r.height > 0 ? `${r.left},${r.top},${r.width},${r.height}` : 'off';
        if (key !== last) {
          last = key;
          const st = el.style;
          if (key === 'fs') {
            st.left = st.top = st.width = st.height = '';
          } else if (key === 'off') {
            st.left = '-10000px';
            st.top = '0px';
            st.width = '320px';
            st.height = '180px';
          } else {
            st.left = `${r!.left}px`;
            st.top = `${r!.top}px`;
            st.width = `${r!.width}px`;
            st.height = `${r!.height}px`;
          }
          setShown(key !== 'off');
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const src = useMemo(() => driver.src(item, expected()), [item.id]);

  return (
    <div
      ref={tile.ref}
      className={`screen-tile bot-tile media-frame ${shown ? 'shown' : ''} ${tile.idle ? 'idle' : ''} ${full.fs ? 'tile-fs' : ''}`}
      onDoubleClick={() => shown && full.toggle()}
      aria-hidden={!shown}
    >
      <div className="bot-video">
        <iframe
          key={item.id}
          ref={frame}
          src={src}
          title="Player de música da call"
          allow="autoplay; encrypted-media"
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={onLoad}
        />
        <div className="bot-shield" />
      </div>
      {shown && (
        <>
          {preview && <PreviewBanner />}
          <div className="tile-top">
            <span className={`yt-badge src-${item.source ?? 'youtube'}`}>▶ {sourceLabel(item.source)}</span>
            <strong title={item.title}>{item.title}</strong>
            {media.queue.length > 1 && <small className="muted">+{media.queue.length - 1} na fila</small>}
          </div>
          <div className="player-controls" onDoubleClick={(e) => e.stopPropagation()}>
            <Seek />
            <div className="player-row">
              <PlayPause media={media} className="pbtn big" />
              <button className="pbtn" title="Próximo da fila" aria-label="Próximo da fila" onClick={() => app.media({ type: 'next' }).catch(fail)}>
                <SkipForward size={20} />
              </button>
              <TimeLabel />
              <span className="player-spacer" />
              <button className="pbtn" title="Só o som (esconde o vídeo)" aria-label="Só o som" onClick={() => setVideo(false)}>
                <Headphones size={20} />
              </button>
              <button className="pbtn" title={full.fs ? 'Sair da tela cheia (Esc)' : 'Tela cheia (duplo clique; Esc sai)'} aria-label="Tela cheia" onClick={full.toggle}>
                {full.fs ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PreviewBanner() {
  return (
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
  );
}

// ---- peças de controle (usadas no palco e no rodapé) ----

function PlayPause({ media, className, size = 22 }: { media: MediaState; className: string; size?: number }) {
  const label = media.playing ? 'Pausar para todos' : 'Tocar para todos';
  return (
    <button
      className={className}
      title={label}
      aria-label={label}
      onClick={() => app.media(media.playing ? { type: 'pause', position: expectedFn() } : { type: 'play' }).catch(fail)}
    >
      {media.playing ? <Pause size={size} fill="currentColor" /> : <Play size={size} fill="currentColor" />}
    </button>
  );
}

function current(dur: number): number {
  return Math.min(expectedFn(), dur || Infinity);
}

function TimeLabel() {
  const { dur } = useClock();
  return (
    <span className="player-time">
      {fmt(current(dur))}
      {dur ? ` / ${fmt(dur)}` : ''}
    </span>
  );
}

function Seek({ showTimes }: { showTimes?: boolean }) {
  const { dur } = useClock();
  const [seeking, setSeeking] = useState<number | null>(null);
  const cur = seeking ?? current(dur);
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
  const commit = () => {
    if (seeking !== null) app.media({ type: 'seek', position: seeking }).catch(fail);
    setSeeking(null);
  };
  return (
    <div className="seek-wrap" style={{ '--pct': `${pct}%` } as React.CSSProperties}>
      {showTimes && <span className="player-time">{fmt(cur)}</span>}
      <input
        className="seek"
        type="range"
        aria-label="Posição"
        min={0}
        max={Math.max(1, Math.floor(dur))}
        step={1}
        value={Math.floor(cur)}
        disabled={!dur}
        onChange={(e) => setSeeking(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      {showTimes && <span className="player-time">{dur ? fmt(dur) : '--:--'}</span>}
    </div>
  );
}

// ---- rodapé ----

/** Player persistente: aparece enquanto a call em que estou tiver fila, em qualquer tela. */
export function PlayerBar() {
  const media = useMyMedia();
  const callConv = useApp((s) => s.call?.conversationId ?? null);
  const conv = useApp((s) => s.conversations.find((c) => c.id === s.call?.conversationId));
  const volume = useApp((s) => s.profile?.settings?.yt_volume ?? 60);
  const deafened = useApp((s) => !!s.call?.deafened);
  const panel = useApp((s) => (s.panelOpen ? s.panelTab : null));
  const { video, preview } = useClock();
  const full = useTileFullscreen('bot');
  if (!media?.queue.length || !callConv) return null;
  const item = media.queue[0];
  const muted = volume === 0 || deafened;
  const VolIcon = muted ? VolumeX : volume < 50 ? Volume1 : Volume2;

  return (
    <footer className="playerbar" aria-label="Player da call">
      <button className="pb-now" title="Ir para a call" onClick={() => app.select(callConv)}>
        <img src={thumbOf(item)} alt="" />
        <span className="pb-info">
          <strong title={item.title}>{item.title}</strong>
          <small className="muted">
            <span className={`yt-badge src-${item.source ?? 'youtube'}`}>{sourceLabel(item.source)}</span>
            {' '}por {app.user(item.added_by)?.display_name ?? '?'}
            {conv ? ` · ${app.conversationTitle(conv)}` : ''}
          </small>
        </span>
      </button>

      <div className="pb-center">
        <div className="pb-buttons">
          {media.queue.length > 2 && (
            <button className="pbtn" title="Embaralhar a fila" aria-label="Embaralhar a fila" onClick={() => app.media({ type: 'shuffle' }).catch(fail)}>
              <Shuffle size={18} />
            </button>
          )}
          <PlayPause media={media} className="pbtn pb-play" size={20} />
          <button className="pbtn" title="Próximo da fila" aria-label="Próximo da fila" onClick={() => app.media({ type: 'next' }).catch(fail)}>
            <SkipForward size={20} fill="currentColor" />
          </button>
        </div>
        <Seek showTimes />
      </div>

      <div className="pb-right">
        {preview && (
          <span className="pb-preview" title="Spotify sem login toca só 30 s">
            prévia 30 s
          </span>
        )}
        <label className="pb-vol" title={`Volume só pra você: ${volume}%`}>
          <button
            className="pbtn"
            aria-label={muted ? 'Ativar som do player' : 'Silenciar player'}
            onClick={(e) => {
              e.preventDefault();
              app.saveSettings({ yt_volume: volume ? 0 : 60 });
            }}
          >
            <VolIcon size={18} />
          </button>
          <input type="range" min={0} max={100} value={volume} aria-label="Volume do player" onChange={(e) => app.saveSettings({ yt_volume: Number(e.target.value) })} />
        </label>
        <button
          className={`pbtn ${video ? 'on' : ''}`}
          title={video ? 'Só o som (esconde o vídeo)' : 'Mostrar o vídeo na call'}
          aria-label={video ? 'Só o som' : 'Mostrar o vídeo'}
          onClick={() => setVideo(!video)}
        >
          {video ? <Video size={18} /> : <Headphones size={18} />}
        </button>
        <button className="pbtn pb-hide-sm" title="Tela cheia" aria-label="Tela cheia" onClick={() => {
          if (!video) setVideo(true);
          full.toggle();
        }}>
          <Maximize2 size={18} />
        </button>
        <button
          className={`pbtn ${panel === 'music' ? 'on' : ''}`}
          title="Fila de reprodução"
          aria-label="Fila de reprodução"
          onClick={() => app.openPanel('music')}
        >
          <ListMusic size={18} />
        </button>
      </div>
    </footer>
  );
}

