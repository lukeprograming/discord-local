import { useEffect, useState } from 'react';
import {
  BellOff,
  ChevronDown,
  Download,
  Hash,
  HeadphoneOff,
  House,
  MicOff,
  Plus,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Star,
  Users,
  Volume2,
} from 'lucide-react';
import { app, useApp, type Page } from '../app.ts';
import type { Availability, Conversation } from '../../../shared/protocol.ts';
import { Avatar, PromptModal } from './common.tsx';
import { Settings } from './Settings.tsx';
import { FavoriteMessages, Search } from './Search.tsx';
import { UpdateBanner } from './Update.tsx';
import { CallDock } from './CallDock.tsx';
import { NotificationBell } from './Notifications.tsx';

type SectionId = 'favs' | 'rooms' | 'dms' | 'groups';

function loadCollapsed(): SectionId[] {
  try {
    return JSON.parse(localStorage.getItem('side-collapsed') || '[]');
  } catch {
    return [];
  }
}

export function Sidebar() {
  const s = useApp((s) => s);
  const [grouping, setGrouping] = useState(false);
  const [settings, setSettings] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [favsOpen, setFavsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<SectionId[]>(loadCollapsed);
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
  const favs = s.conversations.filter((c) => app.isFavConversation(c.id));
  const notFav = (c: Conversation) => !app.isFavConversation(c.id);
  const directs = s.conversations.filter((c) => c.type === 'DIRECT' && notFav(c));
  const groups = s.conversations.filter((c) => c.type === 'GROUP' && notFav(c));
  const rooms = s.conversations.filter((c) => c.type === 'ROOM' && notFav(c));
  const friendIds = new Set(s.friends.filter((f) => f.status === 'ACCEPTED').map((f) => f.user.id));
  const mobile = window.innerWidth <= 700;
  // Sem conversa aberta: no PC o centro mostra o Início; no celular, só a lista.
  const page: Page | null = s.selected ? null : (s.page ?? (mobile ? null : 'home'));

  function toggle(id: SectionId) {
    const next = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id];
    setCollapsed(next);
    try {
      localStorage.setItem('side-collapsed', JSON.stringify(next));
    } catch {
      /* sem storage */
    }
  }

  const unreadIn = (list: Conversation[]) => list.reduce((n, c) => n + (app.isMuted(c.id) ? 0 : (s.unread[c.id] ?? 0)), 0);

  const section = (id: SectionId, title: string, list: Conversation[], add: React.ReactNode, body: React.ReactNode) => {
    const closed = collapsed.includes(id);
    const hidden = closed ? unreadIn(list) : 0;
    return (
      <section className={`side-section ${closed ? 'closed' : ''}`}>
        <h5>
          <button className="section-toggle" aria-expanded={!closed} onClick={() => toggle(id)}>
            <ChevronDown size={14} className="chev" />
            {title}
            {hidden > 0 && <span className="badge">{hidden}</span>}
          </button>
          {add}
        </h5>
        {!closed && body}
      </section>
    );
  };

  const convItem = (c: (typeof s.conversations)[number]) => {
    const peer = app.directPeer(c);
    const online = peer ? s.presences[peer.id] === 'ONLINE' : undefined;
    const st = peer ? app.statusOf(peer.id) : undefined;
    const call = s.calls[c.id];
    const muted = app.isMuted(c.id);
    return (
      <button key={c.id} className={`item ${s.selected === c.id ? 'active' : ''} ${muted ? 'muted-conv' : ''}`} onClick={() => app.select(c.id)}>
        {peer ? (
          <Avatar user={peer} online={online} availability={st?.availability} />
        ) : (
          <span className="avatar group-avatar">
            <Hash size={16} />
          </span>
        )}
        <span className="item-name">
          {app.conversationTitle(c)}
          {peer && !friendIds.has(peer.id) && <small className="muted"> (não é mais amigo)</small>}
          {online && (st?.text || st?.emoji) && (
            <small className="item-status">
              {st.emoji} {st.text}
            </small>
          )}
        </span>
        {muted && <BellOff size={14} className="item-flag" aria-label="silenciada" />}
        {call && call.participants.length > 0 && (
          <span className="badge call-badge" title="Call ativa">
            <Volume2 size={11} /> {call.participants.length}
          </span>
        )}
        {!!s.unread[c.id] && <span className={`badge ${muted ? 'badge-muted' : ''}`}>{s.unread[c.id]}</span>}
      </button>
    );
  };

  const roomItem = (c: Conversation) => {
    const call = s.calls[c.id];
    const inThis = s.call?.conversationId === c.id;
    const muted = app.isMuted(c.id);
    return (
      <div key={c.id} className="room">
        <button
          className={`item ${s.selected === c.id ? 'active' : ''} ${muted ? 'muted-conv' : ''}`}
          onClick={() => app.select(c.id)}
          onContextMenu={(e) => {
            if (!s.admin) return;
            e.preventDefault();
            setRoomPrompt({ mode: 'rename', room: c });
          }}
          title={s.admin ? 'Botão direito: renomear/apagar' : undefined}
        >
          <span className="room-icon">
            <Volume2 size={17} />
          </span>
          <span className="item-name">{app.conversationTitle(c)}</span>
          {muted && <BellOff size={14} className="item-flag" aria-label="silenciada" />}
          {!!s.unread[c.id] && <span className={`badge ${muted ? 'badge-muted' : ''}`}>{s.unread[c.id]}</span>}
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
                <span className="item-name">{app.user(p.user_id)?.display_name}</span>
                {p.muted && <MicOff size={13} className="state-icon" aria-label="microfone desligado" />}
                {p.deafened && <HeadphoneOff size={13} className="state-icon" aria-label="ensurdecido" />}
                {p.screen_sharing && <small className="live">AO VIVO</small>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const nav = (id: Page, label: string, Icon: typeof House, badge?: number) => (
    <button className={`nav-item ${page === id ? 'active' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => app.openPage(id)}>
      <Icon size={18} />
      <span className="item-name">{label}</span>
      {!!badge && <span className="badge">{badge}</span>}
    </button>
  );

  return (
    <aside className="sidebar">
      <div className="me">
        <button className="me-status" title="Mudar status" onClick={() => setStatusOpen(!statusOpen)} disabled={s.connection !== 'online'}>
          <Avatar user={me} size={40} online={s.connection === 'online'} availability={myStatus.availability} />
          <div className="me-name">
            <strong>{me.display_name}</strong>
            <small className="muted">{myStatus.text || myStatus.emoji ? `${myStatus.emoji} ${myStatus.text}` : `@${me.username}`}</small>
          </div>
          <ChevronDown size={16} className="muted" />
        </button>
        {!s.frameless && <NotificationBell className="side-bell" />}
        <button className="icon" title="Configurações" aria-label="Configurações" onClick={() => setSettings(true)}>
          <SettingsIcon size={18} />
        </button>
      </div>

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

      <nav className="side-nav" aria-label="Navegação">
        {nav('home', 'Início', House)}
        {nav('friends', 'Amigos', Users, incoming.length)}
        {nav('downloads', 'Downloads', Download)}
        <button className="nav-item" title="Ctrl+K" onClick={() => setSearching(true)}>
          <SearchIcon size={18} />
          <span className="item-name">Buscar</span>
          <kbd>Ctrl K</kbd>
        </button>
        <button className="nav-item" onClick={() => setFavsOpen(true)}>
          <Star size={18} />
          <span className="item-name">Favoritas</span>
        </button>
      </nav>

      <div className="sidebar-scroll">
        {favs.length > 0 &&
          section('favs', 'Favoritos', favs, null, favs.map((c) => (c.type === 'ROOM' ? roomItem(c) : convItem(c))))}

        {(rooms.length > 0 || s.admin) &&
          section(
            'rooms',
            'Salas',
            rooms,
            s.admin && (
              <button className="section-add" onClick={() => setRoomPrompt({ mode: 'create' })} title="Criar sala" aria-label="Criar sala">
                <Plus size={15} />
              </button>
            ),
            rooms.map(roomItem),
          )}

        {section(
          'dms',
          'Mensagens diretas',
          directs,
          <button className="section-add" onClick={() => app.openPage('friends', 'add')} title="Adicionar amigo" aria-label="Adicionar amigo">
            <Plus size={15} />
          </button>,
          <>
            {directs.map(convItem)}
            {!directs.length && (
              <p className="muted small pad">
                Nenhum amigo ainda. <button className="link" onClick={() => app.openPage('friends', 'add')}>adicionar</button>
              </p>
            )}
          </>,
        )}

        {section(
          'groups',
          'Grupos',
          groups,
          <button className="section-add" onClick={() => setGrouping(true)} title="Criar grupo" aria-label="Criar grupo">
            <Plus size={15} />
          </button>,
          <>
            {groups.map(convItem)}
            {!groups.length && <p className="muted small pad">Nenhum grupo.</p>}
          </>,
        )}
      </div>

      <CallDock />
      <UpdateBanner />

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
