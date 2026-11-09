// Tela de amigos: quem está online, todos, pedidos (recebidos e enviados) e adicionar/convidar.
// Antes isso ficava espalhado na lateral (pedidos no topo, pendentes no meio das DMs).

import { useState } from 'react';
import { Check, Copy, MessageSquare, Phone, UserMinus, UserPlus, Users, X } from 'lucide-react';
import type { Friend } from '../../../shared/protocol.ts';
import { app, useApp, type FriendsTab } from '../app.ts';
import { Avatar, PageHeader } from './common.tsx';

const fail = (e: unknown) => app.toast((e as Error).message);

export function Friends() {
  const s = useApp((s) => s);
  const tab = s.friendsTab;
  const accepted = s.friends.filter((f) => f.status === 'ACCEPTED');
  const incoming = s.friends.filter((f) => f.status === 'INCOMING');
  const outgoing = s.friends.filter((f) => f.status === 'OUTGOING');
  const online = accepted.filter((f) => s.presences[f.user.id] === 'ONLINE');
  const byName = (a: Friend, b: Friend) => a.user.display_name.localeCompare(b.user.display_name);

  const tabs: { id: FriendsTab; label: string; count?: number }[] = [
    { id: 'online', label: 'Online', count: online.length },
    { id: 'all', label: 'Todos', count: accepted.length },
    { id: 'requests', label: 'Pedidos', count: incoming.length + outgoing.length },
    { id: 'add', label: 'Adicionar' },
  ];

  return (
    <section className="page">
      <PageHeader icon={<Users size={20} />} title="Amigos" subtitle={`${online.length} online de ${accepted.length}`}>
        <nav className="page-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`page-tab ${tab === t.id ? 'on' : ''} ${t.id === 'add' ? 'add' : ''}`}
              onClick={() => app.setFriendsTab(t.id)}
            >
              {t.id === 'add' && <UserPlus size={15} />}
              {t.label}
              {!!t.count && t.id === 'requests' && incoming.length > 0 ? <span className="badge">{incoming.length}</span> : null}
            </button>
          ))}
        </nav>
      </PageHeader>
      <div className="page-body">
        {tab === 'online' && <FriendList list={online.sort(byName)} empty="Ninguém online agora." />}
        {tab === 'all' && <FriendList list={accepted.sort(byName)} empty="Nenhum amigo ainda. Use “Adicionar”." />}
        {tab === 'requests' && <Requests incoming={incoming} outgoing={outgoing} />}
        {tab === 'add' && <AddFriend />}
      </div>
    </section>
  );
}

function FriendList({ list, empty }: { list: Friend[]; empty: string }) {
  const s = useApp((s) => s);
  const [removing, setRemoving] = useState<string | null>(null);
  if (!list.length) return <p className="muted page-empty">{empty}</p>;
  return (
    <div className="friend-list">
      {list.map((f) => {
        const on = s.presences[f.user.id] === 'ONLINE';
        const st = app.statusOf(f.user.id);
        const dm = app.directWith(f.user.id);
        const statusText = on ? [st?.emoji, st?.text].filter(Boolean).join(' ') || 'online' : 'offline';
        return (
          <div key={f.user.id} className="friend-row">
            <Avatar user={f.user} size={40} online={on} availability={st?.availability} />
            <div className="friend-name">
              <strong>{f.user.display_name}</strong>
              <small className="muted">
                @{f.user.username} · {statusText}
              </small>
            </div>
            {removing === f.user.id ? (
              <div className="friend-actions">
                <small className="muted">Desfazer amizade?</small>
                <button className="mini red" onClick={() => app.removeFriend(f.user.id).then(() => setRemoving(null)).catch(fail)}>
                  Remover
                </button>
                <button className="mini" onClick={() => setRemoving(null)}>
                  Cancelar
                </button>
              </div>
            ) : (
              <div className="friend-actions">
                {dm && (
                  <button className="circle-btn" title="Mensagem" aria-label={`Mensagem para ${f.user.display_name}`} onClick={() => app.select(dm.id)}>
                    <MessageSquare size={17} />
                  </button>
                )}
                {dm && (
                  <button
                    className="circle-btn"
                    title="Ligar"
                    aria-label={`Ligar para ${f.user.display_name}`}
                    disabled={s.connection !== 'online'}
                    onClick={() => {
                      app.select(dm.id);
                      app.joinCall(dm.id).catch(fail);
                    }}
                  >
                    <Phone size={17} />
                  </button>
                )}
                <button className="circle-btn danger-hover" title="Desfazer amizade" aria-label={`Desfazer amizade com ${f.user.display_name}`} onClick={() => setRemoving(f.user.id)}>
                  <UserMinus size={17} />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Requests({ incoming, outgoing }: { incoming: Friend[]; outgoing: Friend[] }) {
  if (!incoming.length && !outgoing.length) return <p className="muted page-empty">Nenhum pedido pendente.</p>;
  return (
    <div className="friend-list">
      {incoming.length > 0 && <h5 className="list-title">Recebidos ({incoming.length})</h5>}
      {incoming.map((f) => (
        <div key={f.user.id} className="friend-row">
          <Avatar user={f.user} size={40} />
          <div className="friend-name">
            <strong>{f.user.display_name}</strong>
            <small className="muted">@{f.user.username} · quer ser seu amigo</small>
          </div>
          <div className="friend-actions">
            <button className="circle-btn ok" title="Aceitar" aria-label={`Aceitar ${f.user.display_name}`} onClick={() => app.acceptFriend(f.user.id).catch(fail)}>
              <Check size={18} />
            </button>
            <button className="circle-btn danger-hover" title="Recusar" aria-label={`Recusar ${f.user.display_name}`} onClick={() => app.removeFriend(f.user.id).catch(fail)}>
              <X size={18} />
            </button>
          </div>
        </div>
      ))}
      {outgoing.length > 0 && <h5 className="list-title">Enviados ({outgoing.length})</h5>}
      {outgoing.map((f) => (
        <div key={f.user.id} className="friend-row">
          <Avatar user={f.user} size={40} />
          <div className="friend-name">
            <strong>{f.user.display_name}</strong>
            <small className="muted">@{f.user.username} · aguardando resposta</small>
          </div>
          <div className="friend-actions">
            <button className="circle-btn danger-hover" title="Cancelar pedido" aria-label={`Cancelar pedido para ${f.user.display_name}`} onClick={() => app.removeFriend(f.user.id).catch(fail)}>
              <X size={18} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function AddFriend() {
  const online = useApp((s) => s.connection === 'online');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [invite, setInvite] = useState('');
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await app.addFriend(username.trim());
      app.toast(`Pedido enviado para ${username.trim()}`);
      setUsername('');
      app.setFriendsTab('requests');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="add-friend">
      <form className="card" onSubmit={submit}>
        <h3>Adicionar amigo</h3>
        <p className="muted small">Digite o nome de usuário de quem já tem conta neste servidor.</p>
        <div className="add-row">
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ex.: joao" aria-label="Nome de usuário" />
          <button className="primary" disabled={!username.trim() || !online}>
            Enviar pedido
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </form>
      <div className="card">
        <h3>Convidar quem ainda não tem conta</h3>
        <p className="muted small">O código vale uma vez. A pessoa usa ele na primeira tela do app, ao criar a conta.</p>
        {invite ? (
          <div className="invite">
            <code>{invite}</code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(invite);
                setCopied(true);
              }}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
        ) : (
          <button disabled={!online} onClick={() => app.createInvite().then(setInvite).catch((e) => setError(e.message))}>
            Gerar código de convite
          </button>
        )}
      </div>
    </div>
  );
}
