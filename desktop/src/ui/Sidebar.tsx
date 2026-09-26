import { useState } from 'react';
import { app, useApp } from '../app.ts';
import { Avatar } from './common.tsx';
import { Settings } from './Settings.tsx';
import { UpdateBanner } from './Update.tsx';

export function Sidebar() {
  const s = useApp((s) => s);
  const [adding, setAdding] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [settings, setSettings] = useState(false);
  const me = s.profile!.user;

  const incoming = s.friends.filter((f) => f.status === 'INCOMING');
  const outgoing = s.friends.filter((f) => f.status === 'OUTGOING');
  const directs = s.conversations.filter((c) => c.type === 'DIRECT');
  const groups = s.conversations.filter((c) => c.type === 'GROUP');
  const friendIds = new Set(s.friends.filter((f) => f.status === 'ACCEPTED').map((f) => f.user.id));

  const convItem = (c: (typeof s.conversations)[number]) => {
    const peer = app.directPeer(c);
    const online = peer ? s.presences[peer.id] === 'ONLINE' : undefined;
    const call = s.calls[c.id];
    return (
      <button key={c.id} className={`item ${s.selected === c.id ? 'active' : ''}`} onClick={() => app.select(c.id)}>
        {peer ? <Avatar user={peer} online={online} /> : <span className="avatar group-avatar">#</span>}
        <span className="item-name">
          {app.conversationTitle(c)}
          {peer && !friendIds.has(peer.id) && <small className="muted"> (não é mais amigo)</small>}
        </span>
        {call && <span className="badge call-badge" title="Call ativa">🔊 {call.participants.length}</span>}
        {!!s.unread[c.id] && <span className="badge">{s.unread[c.id]}</span>}
      </button>
    );
  };

  return (
    <aside className="sidebar">
      {s.profile!.role === 'host' ? (
        <div className={`session ${s.host.running ? 'on' : ''}`}>
          {s.host.running ? (
            <>
              <div>
                <strong className="conn-online">● Sessão online</strong>
                <small className="muted">{s.host.ip}:{s.host.port}</small>
              </div>
              <button className="mini" onClick={() => app.stopSession()}>Encerrar</button>
            </>
          ) : (
            <button className="primary session-btn" disabled={s.hostBusy} onClick={() => app.startSession()}>
              {s.hostBusy ? 'Iniciando…' : '▶ Iniciar sessão online'}
            </button>
          )}
        </div>
      ) : (
        <div className={`conn conn-${s.connection}`}>
          {s.connection === 'online' && '● conectado ao host'}
          {s.connection === 'connecting' && '● procurando o host…'}
          {s.connection === 'offline' && (
            <>
              ● host offline — histórico disponível
              <button className="link" onClick={() => app.reconnectNow()}>tentar agora</button>
            </>
          )}
        </div>
      )}

      <div className="sidebar-scroll">
        {incoming.length > 0 && (
          <section>
            <h5>Pedidos de amizade</h5>
            {incoming.map((f) => (
              <div key={f.user.id} className="item request">
                <Avatar user={f.user} />
                <span className="item-name">{f.user.display_name}</span>
                <button className="mini green" title="Aceitar" onClick={() => app.acceptFriend(f.user.id).catch((e) => app.toast(e.message))}>✓</button>
                <button className="mini red" title="Recusar" onClick={() => app.removeFriend(f.user.id).catch((e) => app.toast(e.message))}>✕</button>
              </div>
            ))}
          </section>
        )}

        <section>
          <h5>
            Mensagens diretas
            <button className="link" onClick={() => setAdding(true)} title="Adicionar amigo">+ amigo</button>
          </h5>
          {directs.map(convItem)}
          {!directs.length && <p className="muted small pad">Nenhum amigo ainda.</p>}
          {outgoing.map((f) => (
            <div key={f.user.id} className="item pending">
              <Avatar user={f.user} />
              <span className="item-name">{f.user.display_name} <small className="muted">(pendente)</small></span>
              <button className="mini" title="Cancelar pedido" onClick={() => app.removeFriend(f.user.id).catch((e) => app.toast(e.message))}>✕</button>
            </div>
          ))}
        </section>

        <section>
          <h5>
            Grupos
            <button className="link" onClick={() => setGrouping(true)} title="Criar grupo">+ grupo</button>
          </h5>
          {groups.map(convItem)}
        </section>
      </div>

      <UpdateBanner />
      <div className="me">
        <Avatar user={me} online={s.connection === 'online'} />
        <div className="me-name">
          <strong>{me.display_name}</strong>
          <small className="muted">@{me.username}</small>
        </div>
        <button className="icon" title="Configurações" onClick={() => setSettings(true)}>⚙</button>
      </div>

      {adding && <AddFriend onClose={() => setAdding(false)} />}
      {grouping && <CreateGroup onClose={() => setGrouping(false)} />}
      {settings && <Settings onClose={() => setSettings(false)} />}
    </aside>
  );
}

function AddFriend({ onClose }: { onClose: () => void }) {
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [invite, setInvite] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await app.addFriend(username.trim());
      app.toast(`Pedido enviado para ${username}`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Adicionar amigo</h3>
        <label>
          Nome de usuário
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ex: joao" />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={!username.trim()}>Enviar pedido</button>
        </div>
        <hr />
        <p className="muted small">Seu amigo ainda não tem conta? Gere um convite (vale uma vez):</p>
        {invite ? (
          <div className="invite">
            <code>{invite}</code>
            <button type="button" onClick={() => navigator.clipboard.writeText(invite)}>Copiar</button>
          </div>
        ) : (
          <button type="button" onClick={() => app.createInvite().then(setInvite).catch((e) => setError(e.message))}>
            Gerar código de convite
          </button>
        )}
      </form>
    </div>
  );
}

function CreateGroup({ onClose }: { onClose: () => void }) {
  const friends = useApp((s) => s.friends).filter((f) => f.status === 'ACCEPTED');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await app.createGroup(name.trim(), [...picked]);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Novo grupo</h3>
        <label>
          Nome
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </label>
        <h4>Membros</h4>
        {friends.map((f) => (
          <label key={f.user.id} className="check">
            <input
              type="checkbox"
              checked={picked.has(f.user.id)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(f.user.id);
                else next.delete(f.user.id);
                setPicked(next);
              }}
            />
            <Avatar user={f.user} size={24} /> {f.user.display_name}
          </label>
        ))}
        {!friends.length && <p className="muted small">Adicione amigos primeiro.</p>}
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={!name.trim() || !picked.size}>Criar</button>
        </div>
      </form>
    </div>
  );
}
