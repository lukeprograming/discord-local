import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { REACTIONS, type Conversation } from '../../../shared/protocol.ts';
import { materialize, snippet, type RawMessage, type ViewMessage } from '../messages.ts';
import { LinkPreviews } from './LinkPreview.tsx';
import { app, useApp } from '../app.ts';
import { Avatar, formatTime } from './common.tsx';
import { VoiceMessage, VoiceRecorder } from './Voice.tsx';
import { FileCard, UploadList } from './FileCard.tsx';
import { sendFiles } from '../files.ts';
import { parseYouTube, queuePlaylist, queueYouTube } from '../youtube.ts';

const GROUP_WINDOW_MS = 5 * 60_000;
const URL_RE = /(https?:\/\/[^\s<]+)/g;

export function Chat({ conversation }: { conversation: Conversation }) {
  const s = useApp((s) => s);
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [replyTo, setReplyTo] = useState<ViewMessage | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // id da mensagem em edição
  const [menuFor, setMenuFor] = useState<string | null>(null); // ações abertas (toque no celular)
  const [pickerFor, setPickerFor] = useState<string | null>(null); // seletor de reação aberto
  const meId = s.profile?.user.id;

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

  // Mantém a rolagem no fim quando chegam mensagens, a menos que o usuário tenha subido.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversation.id]);

  function submit() {
    if (!text.trim()) return;
    app.send(conversation.id, text, replyTo?.id);
    setText('');
    setReplyTo(null);
    stickToBottom.current = true;
  }

  const canEdit = (m: ViewMessage) => m.sender_id === meId && !m.deleted && !m.attachment;

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
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
      {dragging && <div className="drop-hint">Solte para enviar para {app.conversationTitle(conversation)}</div>}
      <header className="chat-header">
        <button className="icon back-btn" title="Voltar" onClick={() => app.select(null)}>←</button>
        {peer ? <Avatar user={peer} online={s.presences[peer.id] === 'ONLINE'} /> : <span className="avatar group-avatar">#</span>}
        <div className="chat-title">
          <strong>{app.conversationTitle(conversation)}</strong>
          <small className="muted">
            {conversation.type === 'GROUP'
              ? conversation.members.map((m) => m.display_name).join(', ')
              : peer && (s.presences[peer.id] === 'ONLINE' ? 'online' : 'offline')}
          </small>
        </div>
        {!inCall && (
          <button
            className="call-btn"
            disabled={s.connection !== 'online'}
            title={s.connection !== 'online' ? 'Precisa estar conectado' : call ? 'Entrar na call' : 'Iniciar call'}
            onClick={() => app.joinCall(conversation.id).catch((e) => app.toast(e.message))}
          >
            {call ? '🔊 Entrar na call' : '📞 Ligar'}
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
                className={`msg ${grouped ? 'grouped' : ''} ${m.pending ? 'pending' : ''} ${menuFor === m.id ? 'menu-open' : ''} ${replyTo?.id === m.id ? 'replying' : ''}`}
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
            if (e.target.value) app.typing(conversation.id);
          }}
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
            {app.state.call && parseYouTube(p)?.id && (
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
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
