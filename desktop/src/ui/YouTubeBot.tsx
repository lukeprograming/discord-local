// Painel do bot de música (aba "Música" do painel da direita): adicionar link e
// mexer na fila. O player em si está em Media.tsx.

import { useEffect, useState } from 'react';
import type { MediaState } from '../../../shared/protocol.ts';
import { app } from '../app.ts';
import { fetchTitle, mediaInfo, parseMedia, parseYouTube, queuePlaylist, queueYouTube, thumb, thumbOf } from '../youtube.ts';
import { sourceLabel } from '../players.ts';

const fail = (e: unknown) => app.toast((e as Error).message);

/** Painel do bot: adicionar link e mexer na fila. */
export function BotPanel({ media, onClose }: { media: MediaState | undefined; onClose?: () => void }) {
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
        {onClose && <button className="icon" title="Fechar" onClick={onClose}>✕</button>}
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
