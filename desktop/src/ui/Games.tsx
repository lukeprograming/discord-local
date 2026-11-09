// Jogos da call. O servidor só põe os eventos em ordem e guarda o histórico;
// cada app recalcula o estado repassando os eventos (o mesmo resultado em todo mundo).

import { useEffect, useRef, useState } from 'react';
import type { ActivityName } from '../../../shared/protocol.ts';
import { app } from '../app.ts';
import { Avatar } from './common.tsx';

const fail = (e: unknown) => app.toast((e as Error).message);
type Ev = { event: Record<string, unknown>; user_id: string };

/** Histórico da atividade: carrega do servidor e acompanha os eventos novos. */
function useActivity(name: ActivityName): Ev[] | null {
  const [log, setLog] = useState<Ev[] | null>(null);
  useEffect(() => {
    let alive = true;
    const buffered: Ev[] = [];
    let loaded = false;
    const off = app.onActivity((a, event, user_id) => {
      if (a !== name) return;
      const ev = { event, user_id };
      if (!loaded) return void buffered.push(ev);
      setLog((l) => (event.t === 'reset' || event.t === 'clear' ? [ev] : [...(l ?? []), ev]));
    });
    app
      .activityLog(name)
      .then((events) => {
        if (!alive) return;
        loaded = true;
        // Eventos que chegaram enquanto o histórico carregava. Podem repetir o fim do
        // histórico, mas repetir é inofensivo (jogada em casa ocupada / traço igual).
        let all = [...events, ...buffered];
        const lastReset = all.map((x) => x.event.t).lastIndexOf(name === 'quadro' ? 'clear' : 'reset');
        if (lastReset > 0) all = all.slice(lastReset);
        setLog(all);
      })
      .catch(fail);
    return () => {
      alive = false;
      off();
    };
  }, [name]);
  return log;
}

export function GamesPanel({ onClose }: { onClose?: () => void }) {
  const [tab, setTab] = useState<ActivityName>('velha');
  return (
    <div className="bot-panel games-panel">
      <div className="bot-panel-head">
        <strong>🎲 Jogos</strong>
        <div className="games-tabs">
          <button className={tab === 'velha' ? 'on' : ''} onClick={() => setTab('velha')}>#️⃣ Jogo da velha</button>
          <button className={tab === 'quadro' ? 'on' : ''} onClick={() => setTab('quadro')}>🎨 Quadro</button>
        </div>
        {onClose && <button className="icon" title="Fechar" onClick={onClose}>✕</button>}
      </div>
      {tab === 'velha' ? <TicTacToe /> : <Whiteboard />}
    </div>
  );
}

// ---- jogo da velha ----

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6],
];

type Velha = { seats: { X?: string; O?: string }; board: ('X' | 'O' | null)[]; turn: 'X' | 'O'; winner: 'X' | 'O' | 'empate' | null; line: number[] | null; score: Record<string, number> };

function velhaState(log: Ev[]): Velha {
  const s: Velha = { seats: {}, board: Array(9).fill(null), turn: 'X', winner: null, line: null, score: {} };
  for (const { event: e, user_id } of log) {
    if (e.t === 'reset') {
      const keep = s.score;
      Object.assign(s, { board: Array(9).fill(null), turn: 'X', winner: null, line: null, seats: e.keepSeats ? s.seats : {}, score: keep });
      if (e.keepSeats && e.seats) s.seats = e.seats as Velha['seats'];
    } else if (e.t === 'sit' && (e.seat === 'X' || e.seat === 'O') && !s.seats[e.seat]) {
      if (s.seats.X === user_id || s.seats.O === user_id) continue; // um lugar por pessoa
      s.seats[e.seat] = user_id;
    } else if (e.t === 'move' && !s.winner && typeof e.cell === 'number') {
      const cell = e.cell;
      if (cell < 0 || cell > 8 || s.board[cell] || s.seats[s.turn] !== user_id) continue;
      s.board[cell] = s.turn;
      const line = LINES.find((l) => l.every((i) => s.board[i] === s.turn));
      if (line) {
        s.winner = s.turn;
        s.line = line;
        s.score[user_id] = (s.score[user_id] ?? 0) + 1;
      } else if (s.board.every(Boolean)) s.winner = 'empate';
      else s.turn = s.turn === 'X' ? 'O' : 'X';
    }
  }
  return s;
}

function TicTacToe() {
  const log = useActivity('velha');
  const meId = app.me()?.id;
  if (!log) return <small className="muted">Carregando…</small>;
  const s = velhaState(log);
  const mySeat = s.seats.X === meId ? 'X' : s.seats.O === meId ? 'O' : null;
  const send = (event: Record<string, unknown>) => app.sendActivity('velha', event).catch(fail);
  const name = (id?: string) => (id ? app.user(id)?.display_name ?? '?' : '');
  const status = s.winner
    ? s.winner === 'empate'
      ? 'Deu velha! 🤝'
      : `${name(s.seats[s.winner])} (${s.winner}) ganhou! 🎉`
    : !s.seats.X || !s.seats.O
      ? 'Esperando jogadores…'
      : s.seats[s.turn] === meId
        ? `Sua vez (${s.turn})`
        : `Vez de ${name(s.seats[s.turn])} (${s.turn})`;

  return (
    <div className="velha">
      <div className="velha-seats">
        {(['X', 'O'] as const).map((seat) => (
          <div key={seat} className={`velha-seat ${s.turn === seat && !s.winner ? 'turn' : ''}`}>
            <strong className={`mark-${seat}`}>{seat}</strong>
            {s.seats[seat] ? (
              <>
                <Avatar user={app.user(s.seats[seat]!)} size={22} />
                <span>{name(s.seats[seat])}</span>
                <small className="muted">{s.score[s.seats[seat]!] ?? 0} vitórias</small>
              </>
            ) : !mySeat ? (
              <button className="mini" onClick={() => send({ t: 'sit', seat })}>sentar aqui</button>
            ) : (
              <small className="muted">vago</small>
            )}
          </div>
        ))}
      </div>
      <div className="velha-status">{status}</div>
      <div className="velha-board">
        {s.board.map((v, i) => (
          <button
            key={i}
            className={`velha-cell ${v ? `mark-${v}` : ''} ${s.line?.includes(i) ? 'win' : ''}`}
            disabled={!!v || !!s.winner || s.seats[s.turn] !== meId}
            onClick={() => send({ t: 'move', cell: i })}
          >
            {v ?? ''}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        {s.winner && mySeat && (
          <button className="primary" onClick={() => send({ t: 'reset', keepSeats: true, seats: { X: s.seats.O, O: s.seats.X } })}>
            Revanche (troca X/O)
          </button>
        )}
        <button onClick={() => send({ t: 'reset' })}>Novo jogo (libera os lugares)</button>
      </div>
    </div>
  );
}

// ---- quadro de desenho ----

const COLORS = ['#ffffff', '#f23f43', '#f0b232', '#23a55a', '#00a8fc', '#5865f2', '#eb459e', '#111214'];
const W = 960;
const H = 540;

function drawStroke(ctx: CanvasRenderingContext2D, e: Record<string, unknown>) {
  const pts = e.pts as number[] | undefined;
  if (!Array.isArray(pts) || pts.length < 2) return;
  ctx.strokeStyle = typeof e.c === 'string' ? e.c : '#fff';
  ctx.lineWidth = typeof e.w === 'number' ? e.w : 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0] * W, pts[1] * H);
  if (pts.length === 2) ctx.lineTo(pts[0] * W + 0.1, pts[1] * H);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * W, pts[i + 1] * H);
  ctx.stroke();
}

function Whiteboard() {
  const log = useActivity('quadro');
  const canvas = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(4);
  const drawing = useRef<number[] | null>(null);

  // Redesenha tudo quando o histórico muda (é pouco: traços já simplificados).
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !log) return;
    ctx.fillStyle = '#2b2d31';
    ctx.fillRect(0, 0, W, H);
    for (const { event } of log) if (event.t === 'stroke') drawStroke(ctx, event);
  }, [log]);

  function point(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * 1000) / 1000, Math.round(((e.clientY - r.top) / r.height) * 1000) / 1000];
  }

  function finish() {
    const pts = drawing.current;
    drawing.current = null;
    if (!pts) return;
    // Traço longo vai em pedaços (limite de tamanho por evento).
    for (let i = 0; i < pts.length; i += 1200) {
      const part = pts.slice(Math.max(0, i - 2), i + 1200);
      app.sendActivity('quadro', { t: 'stroke', c: color, w: width, pts: part }).catch(fail);
    }
  }

  if (!log) return <small className="muted">Carregando…</small>;
  const artists = [...new Set(log.filter((x) => x.event.t === 'stroke').map((x) => x.user_id))];
  return (
    <div className="quadro">
      <div className="quadro-tools">
        {COLORS.map((c) => (
          <button key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} title={c === '#111214' ? 'borracha (cor do fundo escuro)' : c} />
        ))}
        <input type="range" min={2} max={24} value={width} onChange={(e) => setWidth(Number(e.target.value))} title={`Espessura ${width}`} />
        <small className="muted">{artists.map((u) => app.user(u)?.display_name).join(', ') || 'ninguém desenhou ainda'}</small>
        <button className="mini" onClick={() => app.sendActivity('quadro', { t: 'clear' }).catch(fail)}>limpar</button>
      </div>
      <canvas
        ref={canvas}
        width={W}
        height={H}
        className="quadro-canvas"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = point(e);
          const ctx = canvas.current?.getContext('2d');
          if (ctx) drawStroke(ctx, { c: color, w: width, pts: drawing.current });
        }}
        onPointerMove={(e) => {
          const pts = drawing.current;
          if (!pts) return;
          const [x, y] = point(e);
          const lx = pts[pts.length - 2];
          const ly = pts[pts.length - 1];
          if (Math.abs(x - lx) + Math.abs(y - ly) < 0.004) return; // simplifica
          pts.push(x, y);
          const ctx = canvas.current?.getContext('2d');
          if (ctx) drawStroke(ctx, { c: color, w: width, pts: [lx, ly, x, y] });
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
      />
    </div>
  );
}
