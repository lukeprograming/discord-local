// Visão do chat: o histórico local só cresce (append), então edições, mensagens
// apagadas e reações chegam como mensagens próprias e são aplicadas aqui por cima.

import { isMutation, type Message } from '../../shared/protocol.ts';

export type RawMessage = Message & { pending?: boolean };

export type Reaction = { emoji: string; users: string[]; mine: boolean };

export type ViewMessage = RawMessage & {
  edited: boolean;
  deleted: boolean;
  reactions: Reaction[];
  /** Enquete: último voto de cada pessoa (índices). */
  votes: Record<string, number[]>;
};

export function materialize(list: RawMessage[], meId: string | undefined): {
  visible: ViewMessage[];
  byId: Map<string, ViewMessage>;
} {
  const byId = new Map<string, ViewMessage>();
  const visible: ViewMessage[] = [];
  const reactions = new Map<string, Map<string, Set<string>>>(); // alvo -> emoji -> usuários

  for (const m of list) {
    if (!isMutation(m)) {
      const v: ViewMessage = { ...m, edited: false, deleted: false, reactions: [], votes: {} };
      byId.set(m.id, v);
      visible.push(v);
    }
  }
  // Mudanças em ordem de chegada (a lista já vem ordenada; pendentes no fim).
  for (const m of list) {
    if (m.edit_of) {
      const t = byId.get(m.edit_of);
      if (t && t.sender_id === m.sender_id && !t.deleted && !t.attachment) {
        t.content = m.content;
        t.edited = true;
        if (m.pending) t.pending = true;
      }
    } else if (m.delete_of) {
      const t = byId.get(m.delete_of);
      if (t && t.sender_id === m.sender_id) t.deleted = true;
    } else if (m.vote) {
      const t = byId.get(m.vote.target);
      if (t?.attachment?.kind === 'poll') {
        const n = t.attachment.options.length;
        const opts = m.vote.options.filter((i) => i < n);
        t.votes[m.sender_id] = t.attachment.multi ? opts : opts.slice(0, 1);
      }
    } else if (m.reaction) {
      const { target, emoji, on } = m.reaction;
      let per = reactions.get(target);
      if (!per) reactions.set(target, (per = new Map()));
      let users = per.get(emoji);
      if (!users) per.set(emoji, (users = new Set()));
      if (on) users.add(m.sender_id);
      else users.delete(m.sender_id);
    }
  }
  for (const [target, per] of reactions) {
    const t = byId.get(target);
    if (!t || t.deleted) continue;
    for (const [emoji, users] of per) {
      if (users.size) t.reactions.push({ emoji, users: [...users], mine: !!meId && users.has(meId) });
    }
  }
  return { visible, byId };
}

/** Trecho curto para citação/resposta. */
export function snippet(m: Message | undefined): string {
  if (!m) return 'mensagem não encontrada';
  if (m.attachment?.kind === 'voice') return '🎤 mensagem de voz';
  if (m.attachment?.kind === 'file') return `📎 ${m.attachment.name}`;
  if (m.attachment?.kind === 'poll') return `📊 ${m.attachment.question}`;
  if (m.attachment?.kind === 'reminder') return `⏰ ${m.attachment.text}`;
  const t = m.content.replace(/\s+/g, ' ');
  return t.length > 90 ? t.slice(0, 90) + '…' : t;
}
