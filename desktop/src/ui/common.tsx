import type { UserPublic } from '../../../shared/protocol.ts';

const COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c'];

function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function Avatar({ user, size = 32, online, speaking }: { user?: UserPublic; size?: number; online?: boolean; speaking?: boolean }) {
  const letter = (user?.display_name ?? '?').trim().charAt(0).toUpperCase();
  return (
    <span className={`avatar ${speaking ? 'speaking' : ''}`} style={{ width: size, height: size, background: user ? colorFor(user.id) : '#4e5058', fontSize: size * 0.42 }}>
      {letter}
      {online !== undefined && <span className={`presence ${online ? 'on' : 'off'}`} />}
    </span>
  );
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `ontem ${time}`;
  return `${d.toLocaleDateString('pt-BR')} ${time}`;
}
