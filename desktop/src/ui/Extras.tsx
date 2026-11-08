// Enquetes e lembretes no chat.

import { useEffect, useState } from 'react';
import type { PollAttachment, ReminderAttachment } from '../../../shared/protocol.ts';
import { app } from '../app.ts';
import type { ViewMessage } from '../messages.ts';
import { parseReminder } from '../reminders.ts';

const fail = (e: unknown) => app.toast((e as Error).message);

export function PollCard({ conversationId, m, poll }: { conversationId: string; m: ViewMessage; poll: PollAttachment }) {
  const meId = app.me()?.id ?? '';
  const mine = m.votes[meId] ?? [];
  const voters = Object.entries(m.votes).filter(([, v]) => v.length);
  const total = voters.length;
  const counts = poll.options.map((_, i) => voters.filter(([, v]) => v.includes(i)));
  const max = Math.max(1, ...counts.map((c) => c.length));

  function toggle(i: number) {
    const next = poll.multi ? (mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i]) : mine.includes(i) ? [] : [i];
    app.vote(conversationId, m.id, next).catch(fail);
  }

  return (
    <div className="poll-card" onClick={(e) => e.stopPropagation()}>
      <div className="poll-q">📊 {poll.question}</div>
      <small className="muted">{poll.multi ? 'pode marcar várias' : 'escolha uma'} · {total} {total === 1 ? 'voto' : 'votos'}</small>
      {poll.options.map((o, i) => {
        const who = counts[i];
        const pct = total ? Math.round((who.length / total) * 100) : 0;
        return (
          <button key={i} className={`poll-opt ${mine.includes(i) ? 'mine' : ''} ${who.length === max && total ? 'lead' : ''}`} onClick={() => toggle(i)} title={who.map(([u]) => app.user(u)?.display_name ?? '?').join(', ')}>
            <span className="poll-bar" style={{ width: `${pct}%` }} />
            <span className="poll-check">{mine.includes(i) ? (poll.multi ? '☑' : '◉') : poll.multi ? '☐' : '○'}</span>
            <span className="poll-label">{o}</span>
            <span className="poll-count">{who.length ? `${who.length} · ${pct}%` : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ReminderCard({ r }: { r: ReminderAttachment }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const when = new Date(r.at);
  const diff = r.at - Date.now();
  const label = when.toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const rel =
    diff <= 0 ? 'já passou' : diff < 3600_000 ? `em ${Math.ceil(diff / 60_000)} min` : diff < 86_400_000 ? `em ${Math.round(diff / 3600_000)} h` : `em ${Math.round(diff / 86_400_000)} dias`;
  return (
    <div className={`reminder-card ${diff <= 0 ? 'past' : ''}`}>
      <span className="reminder-icon">⏰</span>
      <div>
        <div className="reminder-text">{r.text}</div>
        <small className="muted">
          {label} · {rel}
        </small>
      </div>
    </div>
  );
}

/** "/enquete Pergunta? | a | b" e "/lembrar 20:30 texto". Devolve true se tratou o comando. */
export function handleSlash(conversationId: string, text: string): boolean {
  const t = text.trim();
  const poll = /^\/(enquete|poll)\s+(.+)$/is.exec(t);
  if (poll) {
    const parts = poll[2].split('|').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) {
      app.toast('Use: /enquete Pergunta? | opção 1 | opção 2');
      return true;
    }
    app.sendPoll(conversationId, { kind: 'poll', question: parts[0], options: parts.slice(1, 11), multi: false }).catch(fail);
    return true;
  }
  const rem = /^\/(lembrar|lembrete|remind)\s+(.+)$/is.exec(t);
  if (rem) {
    const r = parseReminder(rem[2]);
    if (!r) {
      app.toast('Use: /lembrar 20:30 jogar · /lembrar amanhã 9h acordar · /lembrar 15min pizza · /lembrar 25/12 18h ceia');
      return true;
    }
    app.sendReminder(conversationId, r.at, r.text).catch(fail);
    return true;
  }
  return false;
}

export function PollModal({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const valid = question.trim() && options.filter((o) => o.trim()).length >= 2;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal small-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          app
            .sendPoll(conversationId, { kind: 'poll', question: question.trim(), options: options.map((o) => o.trim()).filter(Boolean), multi })
            .then(onClose)
            .catch(fail);
        }}
      >
        <h3>📊 Nova enquete</h3>
        <input autoFocus value={question} maxLength={200} placeholder="Pergunta (ex.: qual jogo hoje?)" onChange={(e) => setQuestion(e.target.value)} />
        {options.map((o, i) => (
          <div key={i} className="poll-edit-row">
            <input
              value={o}
              maxLength={100}
              placeholder={`Opção ${i + 1}`}
              onChange={(e) => {
                const next = [...options];
                next[i] = e.target.value;
                if (i === options.length - 1 && e.target.value && options.length < 10) next.push('');
                setOptions(next);
              }}
            />
          </div>
        ))}
        <label className="check">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Pode marcar mais de uma
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={!valid}>Criar</button>
        </div>
      </form>
    </div>
  );
}

function localInput(ms: number): string {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function ReminderModal({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [when, setWhen] = useState(() => localInput(Date.now() + 3600_000));
  const [text, setText] = useState('');
  const at = new Date(when).getTime();
  const valid = text.trim() && at > Date.now();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal small-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) app.sendReminder(conversationId, at, text.trim()).then(onClose).catch(fail);
        }}
      >
        <h3>⏰ Novo lembrete</h3>
        <small className="muted">Todo mundo da conversa recebe o aviso na hora.</small>
        <input autoFocus value={text} maxLength={300} placeholder="Lembrar de… (ex.: jogar CS)" onChange={(e) => setText(e.target.value)} />
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={!valid}>Criar</button>
        </div>
      </form>
    </div>
  );
}
