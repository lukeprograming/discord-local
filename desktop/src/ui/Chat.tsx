import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Conversation, Message } from '../../../shared/protocol.ts';
import { app, useApp } from '../app.ts';
import { Avatar, formatTime } from './common.tsx';

const GROUP_WINDOW_MS = 5 * 60_000;
const URL_RE = /(https?:\/\/[^\s<]+)/g;

export function Chat({ conversation }: { conversation: Conversation }) {
  const s = useApp((s) => s);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const stored = s.messages[conversation.id] ?? [];
  const pending = s.outbox.filter((m) => m.conversation_id === conversation.id);
  const messages: (Message & { pending?: boolean })[] = [...stored, ...pending.map((m) => ({ ...m, pending: true }))];
  const peer = app.directPeer(conversation);
  const typing = app.typingUsers(conversation.id);
  const call = s.calls[conversation.id];
  const inCall = s.call?.conversationId === conversation.id;

  useEffect(() => {
    inputRef.current?.focus();
    stickToBottom.current = true;
  }, [conversation.id]);

  // Mantém a rolagem no fim quando chegam mensagens, a menos que o usuário tenha subido.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversation.id]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!text.trim()) return;
      app.send(conversation.id, text);
      setText('');
      stickToBottom.current = true;
    }
  }

  return (
    <section className="chat">
      <header className="chat-header">
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
          const grouped = !newDay && prev && prev.sender_id === m.sender_id && m.created_at - prev.created_at < GROUP_WINDOW_MS;
          const author = app.user(m.sender_id);
          return (
            <Fragment key={m.id}>
              {newDay && <div className="day-sep"><span>{new Date(m.created_at).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</span></div>}
              <div className={`msg ${grouped ? 'grouped' : ''} ${m.pending ? 'pending' : ''}`}>
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
                  <div className="msg-text">
                    <Linkify text={m.content} />
                    {m.pending && <small className="muted" title="Será enviada quando conectar"> ⏳</small>}
                  </div>
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>

      <div className="composer">
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
        />
        <div className="typing">
          {typing.length > 0 && `${typing.map((u) => u.display_name).join(', ')} está digitando…`}
        </div>
      </div>
    </section>
  );
}

function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer">
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
