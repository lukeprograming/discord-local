// Downloads: todos os arquivos que passaram pelas conversas, num lugar só. Usa o mesmo
// cartão do chat (FileCard), então baixar/abrir/salvar funciona igual.

import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import type { Conversation, FileAttachment } from '../../../shared/protocol.ts';
import { app, useApp } from '../app.ts';
import { materialize, type ViewMessage } from '../messages.ts';
import { PageHeader, formatTime } from './common.tsx';
import { FileCard } from './FileCard.tsx';

type Item = { conv: Conversation; m: ViewMessage; att: FileAttachment };
type Kind = 'all' | 'image' | 'video' | 'audio' | 'doc' | 'other';

const KINDS: { id: Kind; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'image', label: 'Imagens' },
  { id: 'video', label: 'Vídeos' },
  { id: 'audio', label: 'Áudio' },
  { id: 'doc', label: 'Documentos' },
  { id: 'other', label: 'Outros' },
];

function kindOf(mime: string): Kind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || mime.startsWith('text/') || /word|excel|sheet|presentation|opendocument/.test(mime)) return 'doc';
  return 'other';
}

export function Downloads() {
  const conversations = useApp((s) => s.conversations);
  const meId = useApp((s) => s.profile?.user.id);
  const [items, setItems] = useState<Item[] | null>(null);
  const [kind, setKind] = useState<Kind>('all');
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all(
      conversations.map(async (conv) => {
        const list = materialize(await window.native.loadMessages(conv.id).catch(() => []), meId).visible;
        return list
          .filter((m) => !m.deleted && m.attachment?.kind === 'file')
          .map((m) => ({ conv, m, att: m.attachment as FileAttachment }));
      }),
    ).then((r) => alive && setItems(r.flat().sort((a, b) => b.m.created_at - a.m.created_at)));
    return () => {
      alive = false;
    };
  }, [conversations.length]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (items ?? []).filter(
      (it) => (kind === 'all' || kindOf(it.att.mime) === kind) && (!term || it.att.name.toLowerCase().includes(term)),
    );
  }, [items, kind, q]);

  return (
    <section className="page">
      <PageHeader icon={<Download size={20} />} title="Downloads" subtitle="Arquivos de todas as conversas">
        <input className="page-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar arquivo…" aria-label="Buscar arquivo" />
      </PageHeader>
      <div className="page-body">
        <div className="chips" role="tablist">
          {KINDS.map((k) => (
            <button key={k.id} role="tab" aria-selected={kind === k.id} className={`chip ${kind === k.id ? 'on' : ''}`} onClick={() => setKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>
        {items === null && <p className="muted page-empty">Carregando…</p>}
        {items !== null && !shown.length && <p className="muted page-empty">{items.length ? 'Nada com esse filtro.' : 'Nenhum arquivo nas conversas ainda.'}</p>}
        <div className="download-list">
          {shown.map(({ conv, m, att }) => (
            <div key={m.id} className="download-row">
              <div className="download-meta">
                <button className="link" onClick={() => app.openMessage(conv.id, m.id)} title="Ir para a mensagem">
                  {app.conversationTitle(conv)}
                </button>
                <small className="muted">
                  {app.user(m.sender_id)?.display_name ?? '?'} · {formatTime(m.created_at)}
                </small>
              </div>
              <FileCard conversationId={conv.id} attachment={att} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
