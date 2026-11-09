// Início: o que está acontecendo agora — calls, mensagens não lidas, amigos online e pedidos.

import { Bell, Download, House, MessageSquare, UserPlus, Users, Volume2 } from 'lucide-react';
import { app, useApp } from '../app.ts';
import { Avatar, PageHeader } from './common.tsx';

const fail = (e: unknown) => app.toast((e as Error).message);

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

export function Home() {
  const s = useApp((s) => s);
  const me = s.profile!.user;
  const calls = Object.values(s.calls).filter((c) => c.participants.length > 0);
  const unread = s.conversations.filter((c) => s.unread[c.id]).sort((a, b) => s.unread[b.id] - s.unread[a.id]);
  const online = s.friends.filter((f) => f.status === 'ACCEPTED' && s.presences[f.user.id] === 'ONLINE');
  const incoming = s.friends.filter((f) => f.status === 'INCOMING');

  return (
    <section className="page">
      <PageHeader icon={<House size={20} />} title="Início" subtitle={`${greeting()}, ${me.display_name}`} />
      <div className="page-body home-grid">
        <div className="card">
          <h3>
            <Volume2 size={18} /> Calls agora
          </h3>
          {calls.length ? (
            calls.map((c) => {
              const conv = s.conversations.find((x) => x.id === c.conversation_id);
              const mine = s.call?.conversationId === c.conversation_id;
              return (
                <div key={c.conversation_id} className="home-row">
                  <div className="avatar-stack">
                    {c.participants.slice(0, 4).map((p) => (
                      <Avatar key={p.connection_id} user={app.user(p.user_id)} size={28} />
                    ))}
                  </div>
                  <div className="home-row-text">
                    <strong>{conv ? app.conversationTitle(conv) : 'Call'}</strong>
                    <small className="muted">
                      {c.participants.length} {c.participants.length === 1 ? 'pessoa' : 'pessoas'}
                      {c.participants.some((p) => p.screen_sharing) ? ' · transmitindo' : ''}
                      {c.media?.queue.length ? ' · tocando música' : ''}
                    </small>
                  </div>
                  {mine ? (
                    <button className="mini" onClick={() => app.select(c.conversation_id)}>
                      Ir
                    </button>
                  ) : (
                    <button
                      className="mini green"
                      disabled={s.connection !== 'online'}
                      onClick={() => {
                        app.select(c.conversation_id);
                        app.joinCall(c.conversation_id).catch(fail);
                      }}
                    >
                      Entrar
                    </button>
                  )}
                </div>
              );
            })
          ) : (
            <p className="muted small">Nenhuma call acontecendo.</p>
          )}
        </div>

        <div className="card">
          <h3>
            <MessageSquare size={18} /> Não lidas
          </h3>
          {unread.length ? (
            unread.slice(0, 8).map((c) => {
              const peer = app.directPeer(c);
              return (
                <button key={c.id} className="home-row clickable" onClick={() => app.select(c.id)}>
                  {peer ? <Avatar user={peer} size={28} /> : <span className="avatar group-avatar small-av">#</span>}
                  <span className="home-row-text">
                    <strong>{app.conversationTitle(c)}</strong>
                  </span>
                  <span className={`badge ${app.isMuted(c.id) ? 'badge-muted' : ''}`}>{s.unread[c.id]}</span>
                </button>
              );
            })
          ) : (
            <p className="muted small">Tudo lido por aqui.</p>
          )}
        </div>

        <div className="card">
          <h3>
            <Users size={18} /> Amigos online ({online.length})
          </h3>
          {online.length ? (
            online.map((f) => {
              const st = app.statusOf(f.user.id);
              const dm = app.directWith(f.user.id);
              return (
                <button key={f.user.id} className="home-row clickable" disabled={!dm} onClick={() => dm && app.select(dm.id)}>
                  <Avatar user={f.user} size={28} online availability={st?.availability} />
                  <span className="home-row-text">
                    <strong>{f.user.display_name}</strong>
                    {(st?.text || st?.emoji) && (
                      <small className="muted">
                        {st.emoji} {st.text}
                      </small>
                    )}
                  </span>
                </button>
              );
            })
          ) : (
            <p className="muted small">Ninguém online agora.</p>
          )}
        </div>

        <div className="card">
          <h3>
            <Bell size={18} /> Atalhos
          </h3>
          {incoming.length > 0 && (
            <button className="home-row clickable" onClick={() => app.openPage('friends', 'requests')}>
              <UserPlus size={18} />
              <span className="home-row-text">
                <strong>
                  {incoming.length} {incoming.length === 1 ? 'pedido de amizade' : 'pedidos de amizade'}
                </strong>
              </span>
              <span className="badge">{incoming.length}</span>
            </button>
          )}
          <button className="home-row clickable" onClick={() => app.openPage('friends', 'add')}>
            <UserPlus size={18} />
            <span className="home-row-text">
              <strong>Adicionar ou convidar amigo</strong>
            </span>
          </button>
          <button className="home-row clickable" onClick={() => app.openPage('downloads')}>
            <Download size={18} />
            <span className="home-row-text">
              <strong>Arquivos das conversas</strong>
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}
