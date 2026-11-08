import { useEffect, useState } from 'react';
import { getPreview, type Preview } from '../linkpreview.ts';

const URL_RE = /https:\/\/[^\s<]+/g;
const MAX_PER_MESSAGE = 3;

/** Cartões de prévia para os links https de uma mensagem. */
export function LinkPreviews({ text }: { text: string }) {
  const urls = [...new Set(text.match(URL_RE) ?? [])].slice(0, MAX_PER_MESSAGE);
  if (!urls.length || !window.native.fetchUrl) return null;
  return (
    <>
      {urls.map((u) => (
        <LinkPreview key={u} url={u} />
      ))}
    </>
  );
}

function LinkPreview({ url }: { url: string }) {
  const [p, setP] = useState<Preview | null>(null);
  useEffect(() => {
    let alive = true;
    getPreview(url).then((v) => alive && setP(v));
    return () => {
      alive = false;
    };
  }, [url]);
  if (!p) return null;
  if (p.kind === 'image') {
    return (
      <a className="link-image" href={url} target="_blank" rel="noreferrer">
        <img src={p.image} alt="" />
      </a>
    );
  }
  return (
    <div className="link-card" style={p.color ? { borderLeftColor: p.color } : undefined}>
      <small className="muted">{p.site}</small>
      {p.title && (
        <a href={url} target="_blank" rel="noreferrer" className="link-title">
          {p.title}
        </a>
      )}
      {p.description && <span className="link-desc">{p.description}</span>}
      {p.image && (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={p.image} alt="" />
        </a>
      )}
    </div>
  );
}
