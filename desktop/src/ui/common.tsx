import { useEffect, useRef, useState } from 'react';
import type { Availability, UserPublic } from '../../../shared/protocol.ts';
import { app } from '../app.ts';

const COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c'];

function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

const AVAIL_TITLE: Record<Availability, string> = { online: 'Disponível', idle: 'Ausente', dnd: 'Não perturbe' };

export function Avatar({
  user,
  size = 32,
  online,
  speaking,
  availability,
}: {
  user?: UserPublic;
  size?: number;
  online?: boolean;
  speaking?: boolean;
  availability?: Availability;
}) {
  const letter = (user?.display_name ?? '?').trim().charAt(0).toUpperCase();
  const cls = online ? (availability && availability !== 'online' ? availability : 'on') : 'off';
  return (
    <span className={`avatar ${speaking ? 'speaking' : ''}`} style={{ width: size, height: size, background: user ? colorFor(user.id) : '#4e5058', fontSize: size * 0.42 }}>
      {letter}
      {online !== undefined && <span className={`presence ${cls}`} title={online ? AVAIL_TITLE[availability ?? 'online'] : 'Offline'} />}
    </span>
  );
}

/** Caixinha de texto no lugar do window.prompt (que o Electron não tem). */
export function PromptModal({
  title,
  initial = '',
  placeholder,
  okLabel = 'OK',
  onOk,
  onClose,
  extra,
}: {
  title: string;
  initial?: string;
  placeholder?: string;
  okLabel?: string;
  onOk: (value: string) => Promise<void> | void;
  onClose: () => void;
  extra?: React.ReactNode;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  async function ok() {
    if (!v.trim()) return;
    setBusy(true);
    try {
      await onOk(v.trim());
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal small-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <h3>{title}</h3>
        <input ref={ref} value={v} placeholder={placeholder} maxLength={64} onChange={(e) => setV(e.target.value)} />
        {err && <div className="error">{err}</div>}
        {extra}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={busy || !v.trim()}>{okLabel}</button>
        </div>
      </form>
    </div>
  );
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `ontem ${time}`;
  return `${d.toLocaleDateString('pt-BR')} ${time}`;
}

/** Cabeçalho das telas do centro (Início, Amigos, Downloads). No celular tem o "voltar". */
export function PageHeader({ icon, title, subtitle, children }: { icon: React.ReactNode; title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <header className="page-header">
      <button className="icon back-btn" title="Voltar" aria-label="Voltar" onClick={() => app.openPage(null)}>
        ←
      </button>
      <span className="page-icon">{icon}</span>
      <div className="page-title">
        <h2>{title}</h2>
        {subtitle && <small className="muted">{subtitle}</small>}
      </div>
      {children}
    </header>
  );
}
