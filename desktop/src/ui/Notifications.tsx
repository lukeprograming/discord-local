// Sino: um lugar só para o que está pedindo atenção — pedidos de amizade, calls
// acontecendo sem mim e mensagens não lidas. Não cria alerta novo: mostra o estado
// que já existe (os toasts e notificações do sistema continuam como estavam).

import { useEffect, useRef, useState } from 'react';
import { Bell, Check, CheckCheck, MessageSquare, UserPlus, Volume2, X } from 'lucide-react';
import { app, useApp } from '../app.ts';
import { Avatar } from './common.tsx';

const fail = (e: unknown) => app.toast((e as Error).message);

export function NotificationBell({ className = '' }: { className?: string }) {
  const s = useApp((s) => s);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const incoming = s.friends.filter((f) => f.status === 'INCOMING');
  const calls = Object.values(s.calls).filter((c) => c.participants.length > 0 && c.conversation_id !== s.call?.conversationId);
  const unread = s.conversations.filter((c) => s.unread[c.id]).sort((a, b) => s.unread[b.id] - s.unread[a.id]);
  const unreadCount = unread.reduce((n, c) => n + (app.isMuted(c.id) ? 0 : s.unread[c.id]), 0);
  const count = unreadCount + incoming.length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const go = (id: string) => {
    setOpen(false);
    app.select(id);
  };

  return (
    <div className={`bell-wrap ${className}`} ref={ref}>
      <button
        className={`tb-btn bell ${open ? 'on' : ''}`}
        title="Notificações"
        aria-label={count ? `Notificações: ${count} novas` : 'Notificações'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Bell size={17} />
        {count > 0 && <span className="bell-dot">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="bell-pop" role="dialog" aria-label="Notificações">
          <div className="bell-head">
            <strong>Notificações</strong>
            {unread.length > 0 && (
              <button className="link" onClick={() => app.markAllRead()}>
                <CheckCheck size={14} /> marcar tudo como lido
              </button>
            )}
          </div>
          {!incoming.length && !calls.length && !unread.length && <p className="muted small bell-empty">Nada novo por aqui.</p>}

          {incoming.length > 0 && (
            <section>
              <h5>
                <UserPlus size={13} /> Pedidos de amizade
              </h5>
              {incoming.map((f) => (
                <div key={f.user.id} className="bell-row">
                  <Avatar user={f.user} size={28} />
                  <span className="bell-text">
                    <strong>{f.user.display_name}</strong> quer ser seu amigo
                  </span>
                  <button className="circle-btn ok sm" title="Aceitar" aria-label="Aceitar" onClick={() => app.acceptFriend(f.user.id).catch(fail)}>
                    <Check size={15} />
                  </button>
                  <button className="circle-btn danger-hover sm" title="Recusar" aria-label="Recusar" onClick={() => app.removeFriend(f.user.id).catch(fail)}>
                    <X size={15} />
                  </button>
                </div>
              ))}
            </section>
          )}

          {calls.length > 0 && (
            <section>
              <h5>
                <Volume2 size={13} /> Calls acontecendo
              </h5>
              {calls.map((c) => {
                const conv = s.conversations.find((x) => x.id === c.conversation_id);
                return (
                  <button key={c.conversation_id} className="bell-row clickable" onClick={() => go(c.conversation_id)}>
                    <Avatar user={app.user(c.participants[0].user_id)} size={28} />
                    <span className="bell-text">
                      <strong>{conv ? app.conversationTitle(conv) : 'Call'}</strong> · {c.participants.length}{' '}
                      {c.participants.length === 1 ? 'pessoa' : 'pessoas'}
                    </span>
                  </button>
                );
              })}
            </section>
          )}

          {unread.length > 0 && (
            <section>
              <h5>
                <MessageSquare size={13} /> Não lidas
              </h5>
              {unread.slice(0, 10).map((c) => {
                const peer = app.directPeer(c);
                return (
                  <button key={c.id} className="bell-row clickable" onClick={() => go(c.id)}>
                    {peer ? <Avatar user={peer} size={28} /> : <span className="avatar group-avatar small-av">#</span>}
                    <span className="bell-text">
                      <strong>{app.conversationTitle(c)}</strong>
                    </span>
                    <span className={`badge ${app.isMuted(c.id) ? 'badge-muted' : ''}`}>{s.unread[c.id]}</span>
                  </button>
                );
              })}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
