import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PanelRight } from 'lucide-react';
import { REACTIONS, type Conversation } from '../../../shared/protocol.ts';
import { materialize, snippet, type RawMessage, type ViewMessage } from '../messages.ts';
import { LinkPreviews } from './LinkPreview.tsx';
import { PollCard, PollModal, ReminderCard, ReminderModal, handleSlash } from './Extras.tsx';
import { SharedFolder } from './SharedFolder.tsx';
import { app, useApp } from '../app.ts';
import { Avatar, formatTime } from './common.tsx';
import { VoiceMessage, VoiceRecorder } from './Voice.tsx';
import { FileCard, UploadList } from './FileCard.tsx';
import { sendFiles } from '../files.ts';
import { parseMedia, parseYouTube, queuePlaylist, queueYouTube } from '../youtube.ts';

const GROUP_WINDOW_MS = 5 * 60_000;
const URL_RE = /(https?:\/\/[^\s<]+)/g;

export function Chat({ conversation }: { conversation: Conversation }) {
  const s = useApp((s) => s);
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [extras, setExtras] = useState<null | 'menu' | 'poll' | 'reminder'>(null);
  const [folderOf, setFolderOf] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [replyTo, setReplyTo] = useState<ViewMessage | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // id da mensagem em edição
  const [menuFor, setMenuFor] = useState<string | null>(null); // ações abertas (toque no celular)
  const [pickerFor, setPickerFor] = useState<string | null>(null); // seletor de reação aberto
  const meId = s.profile?.user.id;
  const room = conversation.type === 'ROOM';
  const [mention, setMention] = useState<{ start: number; query: string; index: number } | null>(null);
  const others = conversation.members.filter((m) => m.id !== meId);
  const mentionList = mention
    ? [...others.map((m) => ({ key: m.username, label: m.display_name })), ...(others.length > 1 ? [{ key: 'todos', label: 'avisa todo mundo' }] : [])]
        .filter((o) => o.key.toLowerCase().startsWith(mention.query.toLowerCase()) || o.label.toLowerCase().startsWith(mention.query.toLowerCase()))
        .slice(0, 6)
    : [];

  function peerStatusLine(id: string): string {
    const st = app.statusOf(id);
    const a = st?.availability === 'idle' ? 'ausente' : st?.availability === 'dnd' ? 'não perturbe' : 'online';
    return st?.text || st?.emoji ? `${a} · ${st.emoji} ${st.text}` : a;
  }

  /** Atualiza a lista de @ conforme o texto antes do cursor. */
  function updateMention(value: string, caret: number) {
    const m = /(^|\s)@([\w.-]*)$/.exec(value.slice(0, caret));
    setMention(m ? { start: caret - m[2].length - 1, query: m[2], index: 0 } : null);
  }

  function pickMention(key: string) {
    if (!mention) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next = text.slice(0, mention.start) + `@${key} ` + text.slice(caret);
    setText(next);
    setMention(null);
    const pos = mention.start + key.length + 2;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  const stored = s.messages[conversation.id] ?? [];
  const pending = s.outbox.filter((m) => m.conversation_id === conversation.id);
  const raw: RawMessage[] = [...stored, ...pending.map((m) => ({ ...m, pending: true }))];
  const { visible: messages, byId } = materialize(raw, meId);
  const peer = app.directPeer(conversation);
  const typing = app.typingUsers(conversation.id);
  const call = s.calls[conversation.id];
  const inCall = s.call?.conversationId === conversation.id;
  const mobile = s.platform === 'android';

  useEffect(() => {
    if (!mobile) inputRef.current?.focus(); // no celular abriria o teclado por cima da conversa
    stickToBottom.current = true;
    setReplyTo(null);
    setEditing(null);
    setMenuFor(null);
    setPickerFor(null);
  }, [conversation.id]);

  // Veio da busca: rola até a mensagem e pisca.
  useEffect(() => {
    const j = s.jumpTo;
    if (!j || j.conversationId !== conversation.id || !byId.has(j.messageId)) return;
    stickToBottom.current = false;
    requestAnimationFrame(() => jumpTo(j.messageId));
    app.clearJump();
  }, [s.jumpTo, messages.length, conversation.id]);

  // Mantém a rolagem no fim quando chegam mensagens, a menos que o usuário tenha subido.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversation.id]);

  function submit() {
    if (!text.trim()) return;
    if (text.trim().startsWith('/') && handleSlash(conversation.id, text)) {
      setText('');
      return;
    }
    app.send(conversation.id, text, replyTo?.id);
    setText('');
    setReplyTo(null);
    stickToBottom.current = true;
  }

  const canEdit = (m: ViewMessage) => m.sender_id === meId && !m.deleted && !m.attachment;

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && mentionList.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setMention({ ...mention, index: (mention.index + d + mentionList.length) % mentionList.length });
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        pickMention(mentionList[mention.index]?.key ?? mentionList[0].key);
        return;
      }
      if (e.key === 'Escape') {
        setMention(null);
        return;
      }
    }
    // No celular o Enter do teclado quebra linha; envia pelo botão.
    if (e.key === 'Enter' && !e.shiftKey && !mobile) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape' && replyTo) {
      setReplyTo(null);
    } else if (e.key === 'ArrowUp' && !text) {
      // Seta pra cima com a caixa vazia: edita a minha última mensagem (como no Discord).
      const last = [...messages].reverse().find(canEdit);
      if (last) {
        e.preventDefault();
        setEditing(last.id);
      }
    }
  }

  function reply(m: ViewMessage) {
    setReplyTo(m);
    setMenuFor(null);
    inputRef.current?.focus();
  }

  function remove(m: ViewMessage) {
    setMenuFor(null);
    if (window.confirm('Apagar essa mensagem para todos?')) app.deleteMessage(conversation.id, m.id);
  }

  function toggleReaction(m: ViewMessage, emoji: string) {
    const mine = m.reactions.find((r) => r.emoji === emoji)?.mine;
    app.react(conversation.id, m.id, emoji, !mine);
    setPickerFor(null);
    setMenuFor(null);
  }

  function jumpTo(id: string) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);
  }

  return (
    <section
      className={`chat ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) sendFiles(conversation.id, e.dataTransfer.files);
      }}
    >
      {folderOf && <SharedFolder userId={folderOf} onClose={() => setFolderOf(null)} />}
      {dragging && <div className="drop-hint">Solte para enviar para {app.conversationTitle(conversation)}</div>}
      <header className="chat-header">
        <button className="icon back-btn" title="Voltar" onClick={() => app.select(null)}>←</button>
        {peer ? (
          <Avatar user={peer} online={s.presences[peer.id] === 'ONLINE'} availability={app.statusOf(peer.id)?.availability} />
        ) : (
          <span className="avatar group-avatar">{room ? '🔊' : '#'}</span>
        )}
        <div className="chat-title">
          <strong>{app.conversationTitle(conversation)}</strong>
          <small className="muted">
            {room
              ? `sala fixa · ${conversation.members.length} pessoas · ${conversation.members.filter((m) => s.presences[m.id] === 'ONLINE' || m.id === meId).length} online`
              : conversation.type === 'GROUP'
                ? conversation.members.map((m) => m.display_name).join(', ')
                : peer && (s.presences[peer.id] === 'ONLINE' ? peerStatusLine(peer.id) : 'offline')}
          </small>
        </div>
        <button
          className={`icon ${app.isFavConversation(conversation.id) ? 'fav-on' : ''}`}
          title={app.isFavConversation(conversation.id) ? 'Tirar dos favoritos' : 'Favoritar conversa (fica no topo da lateral)'}
          onClick={() => app.toggleFavConversation(conversation.id)}
        >
          {app.isFavConversation(conversation.id) ? '★' : '☆'}
        </button>
        {peer && (
          <button className="icon" title={`Pasta compartilhada de ${peer.display_name}`} disabled={s.connection !== 'online'} onClick={() => setFolderOf(peer.id)}>
            📁
          </button>
        )}
        <button
          className="icon"
          title={app.isMuted(conversation.id) ? 'Ativar notificações' : 'Silenciar conversa (menção com @ ainda avisa)'}
          onClick={() => app.toggleMuteConversation(conversation.id)}
        >
          {app.isMuted(conversation.id) ? '🔕' : '🔔'}
        </button>
        <button
          className={`icon panel-toggle ${s.panelOpen ? 'on' : ''}`}
          title={s.panelOpen ? 'Fechar painel lateral' : 'Painel lateral (pessoas e ferramentas da call)'}
          aria-label="Painel lateral"
          aria-pressed={s.panelOpen}
          onClick={() => app.setPanelOpen(!s.panelOpen)}
        >
          <PanelRight size={19} />
        </button>
        {!inCall && (
          <button
            className="call-btn"
            disabled={s.connection !== 'online'}
            title={s.connection !== 'online' ? 'Precisa estar conectado' : call ? 'Entrar na call' : 'Iniciar call'}
            onClick={() => app.joinCall(conversation.id).catch((e) => app.toast(e.message))}
          >
            {room ? '🔊 Entrar na voz' : call ? '🔊 Entrar na call' : '📞 Ligar'}
          </button>
        )}
      </header>

      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {!messages.length && <p className="muted pad">Nenhuma mensagem ainda. Diga oi!</p>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
          const grouped =
            !newDay && prev && !m.reply_to && prev.sender_id === m.sender_id && m.created_at - prev.created_at < GROUP_WINDOW_MS;
          const author = app.user(m.sender_id);
          const target = m.reply_to ? byId.get(m.reply_to) : undefined;
          const mine = m.sender_id === meId;
          return (
            <Fragment key={m.id}>
              {newDay && <div className="day-sep"><span>{new Date(m.created_at).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>}
              <div
                id={`msg-${m.id}`}
                className={`msg ${grouped ? 'grouped' : ''} ${!mine && !m.deleted && app.mentionsMe(m.content) ? 'mention-me' : ''} ${m.pending ? 'pending' : ''} ${menuFor === m.id ? 'menu-open' : ''} ${replyTo?.id === m.id ? 'replying' : ''}`}
                onClick={mobile && !m.deleted ? () => setMenuFor(menuFor === m.id ? null : m.id) : undefined}
              >
                {m.reply_to && (
                  <div className="msg-reply" onClick={(e) => { e.stopPropagation(); jumpTo(m.reply_to!); }} title="Ir para a mensagem">
                    <span className="reply-line" />
                    <strong>{target ? app.user(target.sender_id)?.display_name ?? '?' : ''}</strong>
                    <span className="muted">{target?.deleted ? 'mensagem apagada' : snippet(target)}</span>
                  </div>
                )}
                <div className="msg-main">
                {grouped ? (
                  <span className="msg-gutter">{formatTime(m.created_at).slice(-5)}</span>
                ) : (
                  <Avatar user={author} size={40} />
                )}
                <div className="msg-body">
                  {!grouped && (
                    <div className="msg-head">
                      <strong>{author?.display_name ?? 'Desconhecido'}</strong>
                      <small className="muted">{formatTime(m.created_at)}</small>
                      {app.isFavMessage(m.id) && <small className="fav-star" title="Favorita">★</small>}
                    </div>
                  )}
                  {m.deleted ? (
                    <div className="msg-text muted deleted">🗑 mensagem apagada</div>
                  ) : editing === m.id ? (
                    <EditBox
                      initial={m.content}
                      onCancel={() => setEditing(null)}
                      onSave={(t) => {
                        setEditing(null);
                        if (t.trim() !== m.content) app.editMessage(conversation.id, m.id, t);
                      }}
                    />
                  ) : (
                    <div className="msg-text">
                      {m.attachment?.kind === 'voice' ? (
                        <VoiceMessage attachment={m.attachment} />
                      ) : m.attachment?.kind === 'file' ? (
                        <FileCard conversationId={conversation.id} attachment={m.attachment} />
                      ) : m.attachment?.kind === 'poll' ? (
                        <PollCard conversationId={conversation.id} m={m} poll={m.attachment} />
                      ) : m.attachment?.kind === 'reminder' ? (
                        <ReminderCard r={m.attachment} />
                      ) : (
                        <>
                          <Linkify text={m.content} />
                          {m.edited && <small className="muted edited"> (editada)</small>}
                        </>
                      )}
                      {m.pending && <small className="muted" title="Será enviada quando conectar"> ⏳</small>}
                    </div>
                  )}
                  {!m.deleted && !m.attachment && editing !== m.id && <LinkPreviews text={m.content} />}
                  {m.reactions.length > 0 && (
                    <div className="reactions">
                      {m.reactions.map((r) => (
                        <button
                          key={r.emoji}
                          className={`reaction ${r.mine ? 'mine' : ''}`}
                          title={r.users.map((u) => app.user(u)?.display_name ?? '?').join(', ')}
                          onClick={(e) => { e.stopPropagation(); toggleReaction(m, r.emoji); }}
                        >
                          {r.emoji} <span>{r.users.length}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {!m.deleted && !m.pending && editing !== m.id && (
                  <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
                    <button title="Reagir" onClick={() => setPickerFor(pickerFor === m.id ? null : m.id)}>😀</button>
                    <button title="Responder" onClick={() => reply(m)}>↩</button>
                    <button
                      title={app.isFavMessage(m.id) ? 'Tirar dos favoritos' : 'Favoritar mensagem'}
                      onClick={() => {
                        app.toggleFavMessage(conversation.id, m.id);
                        setMenuFor(null);
                      }}
                    >
                      {app.isFavMessage(m.id) ? '★' : '☆'}
                    </button>
                    {canEdit(m) && <button title="Editar" onClick={() => { setEditing(m.id); setMenuFor(null); }}>✏️</button>}
                    {mine && <button title="Apagar" onClick={() => remove(m)}>🗑</button>}
                    {pickerFor === m.id && (
                      <div className="reaction-picker">
                        {REACTIONS.map((e) => (
                          <button key={e} onClick={() => toggleReaction(m, e)}>{e}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>

      <div className="composer">
        <UploadList conversationId={conversation.id} />
        {mention && mentionList.length > 0 && (
          <div className="mention-list">
            {mentionList.map((o, i) => (
              <button
                key={o.key}
                className={i === mention.index ? 'on' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickMention(o.key)}
              >
                <strong>@{o.key}</strong> <span className="muted">{o.label}</span>
              </button>
            ))}
          </div>
        )}
        {replyTo && (
          <div className="reply-bar">
            <span>
              ↩ Respondendo a <strong>{app.user(replyTo.sender_id)?.display_name ?? '?'}</strong>
              <span className="muted"> — {snippet(replyTo)}</span>
            </span>
            <button className="icon" title="Cancelar resposta (Esc)" onClick={() => setReplyTo(null)}>✕</button>
          </div>
        )}
        <div className="composer-row">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) sendFiles(conversation.id, e.target.files);
            e.target.value = '';
          }}
        />
        {!recording && (
          <div className="extras-wrap">
            <button className="attach-btn" title="Enquete / lembrete" onMouseDown={(e) => e.preventDefault()} onClick={() => setExtras(extras === 'menu' ? null : 'menu')}>
              ➕
            </button>
            {extras === 'menu' && (
              <div className="extras-menu">
                <button onClick={() => setExtras('poll')}>📊 Enquete <small className="muted">/enquete P? | a | b</small></button>
                <button onClick={() => setExtras('reminder')}>⏰ Lembrete <small className="muted">/lembrar 20:30 texto</small></button>
              </div>
            )}
          </div>
        )}
        {extras === 'poll' && <PollModal conversationId={conversation.id} onClose={() => setExtras(null)} />}
        {extras === 'reminder' && <ReminderModal conversationId={conversation.id} onClose={() => setExtras(null)} />}
        {!recording && (
          <button
            className="attach-btn"
            title={s.connection !== 'online' ? 'Precisa estar conectado para enviar arquivo' : 'Enviar arquivo'}
            disabled={s.connection !== 'online'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileInput.current?.click()}
          >
            📎
          </button>
        )}
        {!recording && (
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={`Mensagem para ${app.conversationTitle(conversation)}${s.connection !== 'online' ? ' (vai quando conectar)' : ''}`}
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            if (e.target.value) app.typing(conversation.id);
          }}
          onBlur={() => setTimeout(() => setMention(null), 150)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            // Print/imagem copiada: vira arquivo.
            if (e.clipboardData.files.length && s.connection === 'online') {
              e.preventDefault();
              sendFiles(conversation.id, e.clipboardData.files);
            }
          }}
        />
        )}
        {mobile && text.trim() ? (
          <button className="send-btn" title="Enviar" onMouseDown={(e) => e.preventDefault()} onClick={submit}>
            ➤
          </button>
        ) : (
          !text.trim() && <VoiceRecorder conversationId={conversation.id} onRecording={setRecording} />
        )}
        </div>
        <div className="typing">
          {typing.length > 0 && `${typing.map((u) => u.display_name).join(', ')} está digitando…`}
        </div>
      </div>
    </section>
  );
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [t, setT] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <div className="edit-box" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={t}
        rows={1}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSave(t);
          }
        }}
      />
      <small className="muted">
        Esc para <button className="link" onClick={onCancel}>cancelar</button> · Enter para <button className="link" onClick={() => onSave(t)}>salvar</button>
        {!t.trim() && ' (vazia = apagar)'}
      </small>
    </div>
  );
}

function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <Fragment key={i}>
            <a href={p} target="_blank" rel="noreferrer">
              {p}
            </a>
            {app.state.call && (parseYouTube(p)?.id || parseMedia(p)) && (
              <button
                className="mini yt-play"
                title="Tocar no bot do YouTube da call (todos ouvem juntos)"
                onClick={() => queueYouTube(p).catch((e) => app.toast((e as Error).message))}
              >
                ▶ tocar na call
              </button>
            )}
            {app.state.call && parseYouTube(p)?.list && (
              <button
                className="mini yt-play"
                title="Põe a playlist inteira na fila do bot da call"
                onClick={() => {
                  app.toast('Carregando a playlist…');
                  queuePlaylist(p)
                    .then((n) => app.toast(`Playlist: ${n} vídeos na fila`))
                    .catch((e) => app.toast((e as Error).message));
                }}
              >
                ▶ playlist na call
              </button>
            )}
          </Fragment>
        ) : (
          <Mentions key={i} text={p} />
        ),
      )}
    </>
  );
}

/** Destaca @usuario (e @todos) no texto. */
function Mentions({ text }: { text: string }) {
  const parts = text.split(/(@[\w.-]+)/g);
  if (parts.length === 1) return <>{text}</>;
  const me = app.me()?.username.toLowerCase();
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
        const name = p.slice(1).toLowerCase();
        const known = name === 'todos' || name === 'everyone' || !!app.userByUsername(name);
        if (!known) return <Fragment key={i}>{p}</Fragment>;
        return (
          <span key={i} className={`mention ${name === me || name === 'todos' || name === 'everyone' ? 'me' : ''}`}>
            {p}
          </span>
        );
      })}
    </>
  );
}
