import { useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation } from '../../../shared/protocol.ts';
import { app, useApp } from '../app.ts';
import { materialize, type ViewMessage } from '../messages.ts';
import { formatTime } from './common.tsx';

type Hit = { conv: Conversation; m: ViewMessage; text: string };

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function textOf(m: ViewMessage): string {
  if (m.attachment?.kind === 'file') return `📎 ${m.attachment.name}`;
  if (m.attachment?.kind === 'voice') return '';
  return m.content;
}

/** Busca em todas as conversas (o histórico está todo neste aparelho, então funciona offline). */
export function Search({ onClose }: { onClose: () => void }) {
  const conversations = useApp((s) => s.conversations);
  const meId = useApp((s) => s.profile?.user.id);
  const [q, setQ] = useState('');
  const [all, setAll] = useState<{ conv: Conversation; list: ViewMessage[] }[] | null>(null);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    let alive = true;
    Promise.all(
      conversations.map(async (conv) => ({
        conv,
        list: materialize(await window.native.loadMessages(conv.id).catch(() => []), meId).visible,
      })),
    ).then((r) => alive && setAll(r));
    return () => {
      alive = false;
    };
  }, []);

  const hits = useMemo<Hit[]>(() => {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    if (!all || !terms.length) return [];
    const out: Hit[] = [];
    for (const { conv, list } of all) {
      for (const m of list) {
        if (m.deleted) continue;
        const text = textOf(m);
        const hay = norm(`${text} ${app.user(m.sender_id)?.display_name ?? ''}`);
        if (terms.every((t) => hay.includes(t))) out.push({ conv, m, text });
      }
    }
    return out.sort((a, b) => b.m.created_at - a.m.created_at).slice(0, 100);
  }, [q, all]);

  useEffect(() => setSel(0), [q]);

  function open(h: Hit) {
    app.openMessage(h.conv.id, h.m.id);
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal search-modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={q}
          placeholder="Buscar em todas as conversas… (nome, palavra, arquivo)"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((i) => Math.min(hits.length - 1, i + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((i) => Math.max(0, i - 1));
            }
            if (e.key === 'Enter' && hits[sel]) open(hits[sel]);
          }}
        />
        <div className="search-results">
          {!all && <p className="muted small">Lendo o histórico…</p>}
          {all && q.trim() && !hits.length && <p className="muted small">Nada encontrado.</p>}
          {hits.map((h, i) => (
            <button key={h.m.id} className={`search-hit ${i === sel ? 'on' : ''}`} onClick={() => open(h)} onMouseEnter={() => setSel(i)}>
              <div className="search-meta">
                <strong>{app.user(h.m.sender_id)?.display_name ?? '?'}</strong>
                <span className="muted">em {app.conversationTitle(h.conv)}</span>
                <small className="muted">{formatTime(h.m.created_at)}</small>
              </div>
              <Highlight text={h.text} q={q} />
            </button>
          ))}
        </div>
        <small className="muted">↑↓ para escolher · Enter abre · Esc fecha {hits.length === 100 && '· mostrando os 100 mais recentes'}</small>
      </div>
    </div>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const n = norm(text);
  // Recorte em volta do primeiro termo achado.
  const first = Math.min(...terms.map((t) => n.indexOf(t)).filter((i) => i >= 0), n.length);
  const start = Math.max(0, first - 40);
  const cut = text.slice(start, start + 180);
  const ncut = n.slice(start, start + 180);
  const marks: [number, number][] = [];
  for (const t of terms) {
    let i = ncut.indexOf(t);
    while (i >= 0) {
      marks.push([i, i + t.length]);
      i = ncut.indexOf(t, i + t.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    parts.push(cut.slice(pos, a), <mark key={a}>{cut.slice(a, b)}</mark>);
    pos = b;
  }
  parts.push(cut.slice(pos));
  return (
    <span className="search-text">
      {start > 0 && '…'}
      {parts}
      {start + 180 < text.length && '…'}
    </span>
  );
}
