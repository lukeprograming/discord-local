import { useEffect, useState } from 'react';
import { app, useApp } from '../app.ts';
import type { Availability, Conversation } from '../../../shared/protocol.ts';
import { Avatar, PromptModal } from './common.tsx';
import { Settings } from './Settings.tsx';
import { FavoriteMessages, Search } from './Search.tsx';
import { UpdateBanner } from './Update.tsx';

export function Sidebar() {
  const s = useApp((s) => s);
  const [adding, setAdding] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [settings, setSettings] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [favsOpen, setFavsOpen] = useState(false);
  // Ctrl+K / Ctrl+Shift+F abrem a busca de qualquer lugar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || (e.shiftKey && e.key.toLowerCase() === 'f'))) {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [roomPrompt, setRoomPrompt] = useState<{ mode: 'create' } | { mode: 'rename'; room: Conversation } | null>(null);
  const me = s.profile!.user;
  const myStatus = app.myStatus();

  const incoming = s.friends.filter((f) => f.status === 'INCOMING');
  const outgoing = s.friends.filter((f) => f.status === 'OUTGOING');
  const favs = s.conversations.filter((c) => app.isFavConversation(c.id));
  const notFav = (c: Conversation) => !app.isFavConversation(c.id);
  const directs = s.conversations.filter((c) => c.type === 'DIRECT' && notFav(c));
  const groups = s.conversations.filter((c) => c.type === 'GROUP' && notFav(c));
  const rooms = s.conversations.filter((c) => c.type === 'ROOM' && notFav(c));
  const friendIds = new Set(s.friends.filter((f) => f.status === 'ACCEPTED').map((f) => f.user.id));

  const convItem = (c: (typeof s.conversations)[number]) => {
    const peer = app.directPeer(c);
    const online = peer ? s.presences[peer.id] === 'ONLINE' : undefined;
    const st = peer ? app.statusOf(peer.id) : undefined;
    const call = s.calls[c.id];
    const muted = app.isMuted(c.id);
    return (
      <button key={c.id} className={`item ${s.selected === c.id ? 'active' : ''} ${muted ? 'muted-conv' : ''}`} onClick={() => app.select(c.id)}>
        {peer ? <Avatar user={peer} online={online} availability={st?.availability} /> : <span className="avatar group-avatar">#</span>}
        <span className="item-name">
          {app.conversationTitle(c)}
          {peer && !friendIds.has(peer.id) && <small className="muted"> (não é mais amigo)</small>}
          {online && (st?.text || st?.emoji) && (
            <small className="item-status">
              {st.emoji} {st.text}
            </small>
          )}
        </span>
        {muted && <span title="Silenciada">🔕</span>}
        {call && <span className="badge call-badge" title="Call ativa">🔊 {call.participants.length}</span>}
        {!!s.unread[c.id] && <span className={`badge ${muted ? 'badge-muted' : ''}`}>{s.unread[c.id]}</span>}
      </button>
    );
  };

  const roomItem = (c: Conversation) => {
    const call = s.calls[c.id];
    const inThis = s.call?.conversationId === c.id;
    return (
      <div key={c.id} className="room">
        <button
          className={`item ${s.selected === c.id ? 'active' : ''} ${app.isMuted(c.id) ? 'muted-conv' : ''}`}
          onClick={() => app.select(c.id)}
          onContextMenu={(e) => {
            if (!s.admin) return;
            e.preventDefault();
            setRoomPrompt({ mode: 'rename', room: c });
          }}
          title={s.admin ? 'Botão direito: renomear/apagar' : undefined}
        >
          <span className="room-icon">🔊</span>
          <span className="item-name">{app.conversationTitle(c)}</span>
          {app.isMuted(c.id) && <span title="Silenciada">🔕</span>}
          {!!s.unread[c.id] && <span className={`badge ${app.isMuted(c.id) ? 'badge-muted' : ''}`}>{s.unread[c.id]}</span>}
          {!inThis && (
            <span
              className="room-join"
              title="Entrar na voz"
              onClick={(e) => {
                e.stopPropagation();
                app.select(c.id);
                app.joinCall(c.id).catch((err) => app.toast(err.message));
              }}
            >
              entrar
            </span>
          )}
        </button>
        {call && call.participants.length > 0 && (
          <div className="room-people">
            {call.participants.map((p) => (
              <div key={p.connection_id} className="room-person">
                <Avatar user={app.user(p.user_id)} size={20} speaking={inThis && (p.connection_id === s.connectionId ? s.call?.localSpeaking : s.call?.remotes().find((r) => r.connectionId === p.connection_id)?.speaking)} />
                <span>{app.user(p.user_id)?.display_name}</span>
                {p.muted && <small>🔇</small>}
                {p.deafened && <small>🙉</small>}
                {p.screen_sharing && <small className="live">AO VIVO</small>}
              </div>
            ))}
          </div>
        )}
      </div>
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
              <button className="link" title="O host mudou de VPN/IP? Troque o endereço" onClick={() => setSettings(true)}>mudar endereço</button>
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

        {favs.length > 0 && (
          <section>
            <h5>⭐ Favoritos</h5>
            {favs.map((c) => (c.type === 'ROOM' ? roomItem(c) : convItem(c)))}
          </section>
        )}

        {(rooms.length > 0 || s.admin) && (
          <section>
            <h5>
              Salas
              {s.admin && (
                <button className="link" onClick={() => setRoomPrompt({ mode: 'create' })} title="Criar sala">
                  + sala
                </button>
              )}
            </h5>
            {rooms.map(roomItem)}
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
        <button className="me-status" title="Mudar status" onClick={() => setStatusOpen(!statusOpen)} disabled={s.connection !== 'online'}>
          <Avatar user={me} online={s.connection === 'online'} availability={myStatus.availability} />
          <div className="me-name">
            <strong>{me.display_name}</strong>
            <small className="muted">{myStatus.text || myStatus.emoji ? `${myStatus.emoji} ${myStatus.text}` : `@${me.username}`}</small>
          </div>
        </button>
        <button className="icon" title="Mensagens favoritas" onClick={() => setFavsOpen(true)}>⭐</button>
        <button className="icon" title="Buscar mensagens (Ctrl+K)" onClick={() => setSearching(true)}>🔍</button>
        <button className="icon" title="Configurações" onClick={() => setSettings(true)}>⚙</button>
      </div>

      {adding && <AddFriend onClose={() => setAdding(false)} />}
      {grouping && <CreateGroup onClose={() => setGrouping(false)} />}
      {settings && <Settings onClose={() => setSettings(false)} />}
      {statusOpen && <StatusEditor onClose={() => setStatusOpen(false)} />}
      {searching && <Search onClose={() => setSearching(false)} />}
      {favsOpen && <FavoriteMessages onClose={() => setFavsOpen(false)} />}
      {roomPrompt?.mode === 'create' && (
        <PromptModal
          title="Nova sala"
          placeholder="ex.: Jogos, Música, Estudos"
          okLabel="Criar"
          onOk={async (name) => {
            const c = await app.createRoom(name);
            app.select(c.id);
          }}
          onClose={() => setRoomPrompt(null)}
        />
      )}
      {roomPrompt?.mode === 'rename' && (
        <RoomEditor room={roomPrompt.room} onClose={() => setRoomPrompt(null)} />
      )}
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

const AVAILABILITY: { v: Availability; label: string; hint: string }[] = [
  { v: 'online', label: '🟢 Disponível', hint: '' },
  { v: 'idle', label: '🌙 Ausente', hint: 'fica sozinho depois de 10 min parado' },
  { v: 'dnd', label: '⛔ Não perturbe', hint: 'sem notificações' },
];
const STATUS_EMOJIS = ['🎮', '🎧', '💻', '📚', '🍕', '😴', '🏃', '🎬'];

function StatusEditor({ onClose }: { onClose: () => void }) {
  const current = app.myStatus();
  const [text, setText] = useState(current.text);
  const [emoji, setEmoji] = useState(current.emoji);
  const save = (patch: Partial<typeof current>) =>
    app.setStatus({ ...current, text, emoji, ...patch }).catch((e) => app.toast(e.message));
  return (
    <div className="status-pop" onClick={(e) => e.stopPropagation()}>
      {AVAILABILITY.map((a) => (
        <button key={a.v} className={`status-opt ${current.availability === a.v ? 'on' : ''}`} onClick={() => save({ availability: a.v })}>
          {a.label} {a.hint && <small className="muted">{a.hint}</small>}
        </button>
      ))}
      <hr />
      <div className="status-emojis">
        {STATUS_EMOJIS.map((e) => (
          <button key={e} className={emoji === e ? 'on' : ''} onClick={() => setEmoji(emoji === e ? '' : e)}>
            {e}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({}).then(onClose);
        }}
      >
        <input value={text} maxLength={80} placeholder="O que você está fazendo? (ex.: jogando CS)" onChange={(e) => setText(e.target.value)} />
        <div className="modal-actions">
          <button type="button" onClick={() => app.setStatus({ ...current, text: '', emoji: '' }).then(onClose).catch((e) => app.toast(e.message))}>
            Limpar
          </button>
          <button type="button" onClick={onClose}>Fechar</button>
          <button type="submit" className="primary">Salvar</button>
        </div>
      </form>
    </div>
  );
}

function RoomEditor({ room, onClose }: { room: Conversation; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal small-modal" onClick={(e) => e.stopPropagation()}>
          <h3>Apagar a sala "{room.name}"?</h3>
          <p className="muted small">Some da lateral de todo mundo. O histórico de mensagens continua guardado no PC de cada um.</p>
          <div className="modal-actions">
            <button onClick={onClose}>Cancelar</button>
            <button className="danger" onClick={() => app.deleteRoom(room.id).then(onClose).catch((e) => app.toast(e.message))}>
              Apagar
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <PromptModal
      title="Renomear sala"
      initial={room.name ?? ''}
      okLabel="Salvar"
      onOk={(name) => app.renameRoom(room.id, name)}
      onClose={onClose}
      extra={<button type="button" className="link danger-link" onClick={() => setConfirming(true)}>apagar sala…</button>}
    />
  );
}
