// Lembretes: cada aparelho da conversa avisa na hora marcada (uma vez só por aparelho).

import type { Message } from '../../shared/protocol.ts';
import { app } from './app.ts';

const timers = new Map<string, number>();
const FIRED_KEY = 'reminders-fired';
const MAX_TIMEOUT = 2 ** 31 - 1; // ~24 dias

function fired(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FIRED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function markFired(id: string): void {
  try {
    const s = [...fired(), id].slice(-500);
    localStorage.setItem(FIRED_KEY, JSON.stringify(s));
  } catch {
    /* sem storage */
  }
}

function fire(m: Message): void {
  timers.delete(m.id);
  if (m.attachment?.kind !== 'reminder' || fired().has(m.id)) return;
  markFired(m.id);
  const conv = app.state.conversations.find((c) => c.id === m.conversation_id);
  const who = app.user(m.sender_id)?.display_name ?? 'Alguém';
  const where = conv ? ` (${app.conversationTitle(conv)})` : '';
  app.notify(`⏰ Lembrete${where}`, `${m.attachment.text} — marcado por ${who}`, true);
  app.toast(`⏰ ${m.attachment.text}`);
}

export function scheduleReminder(m: Message): void {
  if (m.attachment?.kind !== 'reminder' || timers.has(m.id) || fired().has(m.id)) return;
  const wait = m.attachment.at - Date.now();
  // Já passou há pouco (app estava fechado): avisa agora; muito antigo, ignora.
  if (wait <= 0) {
    if (wait > -6 * 3600_000) fire(m);
    else markFired(m.id);
    return;
  }
  // Celular: notificação agendada no sistema (toca mesmo com o app em segundo plano).
  window.native.scheduleNotification?.(m.id, m.attachment.at, '⏰ Lembrete', m.attachment.text);
  if (wait > MAX_TIMEOUT) return; // muito longe: agenda de novo quando o app abrir mais perto
  timers.set(m.id, window.setTimeout(() => fire(m), wait));
}

/** Ao conectar: procura lembretes futuros em todas as conversas deste aparelho. */
export async function scheduleAllReminders(): Promise<void> {
  for (const conv of app.state.conversations) {
    const list = await window.native.loadMessages(conv.id).catch(() => [] as Message[]);
    const deleted = new Set(list.filter((m) => m.delete_of).map((m) => m.delete_of));
    for (const m of list) if (m.attachment?.kind === 'reminder' && !deleted.has(m.id)) scheduleReminder(m);
  }
}

/** "/lembrar 20:30 jogar", "/lembrar amanhã 9h acordar", "/lembrar 10min pizza", "/lembrar 25/12 18h ceia". */
export function parseReminder(input: string, now = new Date()): { at: number; text: string } | null {
  let rest = input.trim();
  const rel = /^(?:em\s+)?(\d+)\s*(min|m|h|hora|horas|minutos?)\b\s*/i.exec(rest);
  if (rel) {
    const n = Number(rel[1]);
    const ms = /^h/i.test(rel[2]) ? n * 3600_000 : n * 60_000;
    const text = rest.slice(rel[0].length).trim();
    return text ? { at: now.getTime() + ms, text } : null;
  }
  const d = new Date(now);
  let dayGiven = false;
  const tomorrow = /^amanh[ãa]\s*/i.exec(rest);
  if (tomorrow) {
    d.setDate(d.getDate() + 1);
    dayGiven = true;
    rest = rest.slice(tomorrow[0].length);
  }
  const date = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*/.exec(rest);
  if (date) {
    d.setMonth(Number(date[2]) - 1, Number(date[1]));
    if (date[3]) d.setFullYear(Number(date[3].length === 2 ? '20' + date[3] : date[3]));
    dayGiven = true;
    rest = rest.slice(date[0].length);
  }
  const time = /^(?:às\s+|as\s+)?(\d{1,2})(?:[:h](\d{2})?)?h?\s*/i.exec(rest);
  if (!time || (!/[:h]/i.test(time[0]) && !dayGiven)) return null;
  const hh = Number(time[1]);
  const mm = Number(time[2] ?? 0);
  if (hh > 23 || mm > 59) return null;
  d.setHours(hh, mm, 0, 0);
  if (!dayGiven && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1); // hora que já passou hoje = amanhã
  const text = rest.slice(time[0].length).trim();
  return text ? { at: d.getTime(), text } : null;
}
