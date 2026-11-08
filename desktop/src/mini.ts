// Miniatura da transmissão: janelinha sempre por cima dos outros apps.
//
// A janela é aberta com window.open('') (about:blank, mesma origem e mesmo
// processo), então o vídeo dela usa direto o MediaStream que já chega aqui —
// sem renegociar nada. O processo principal deixa ela sem moldura e no topo.

import { app } from './app.ts';

export const MINI_NAME = 'dl-mini';
const TITLE = 'Discord Local — mini';

let win: Window | null = null;
let connId: string | null = null;
let video: HTMLVideoElement | null = null;
let label: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 100%; height: 100%; background: #000; overflow: hidden; font: 13px system-ui, sans-serif; color: #f2f3f5; }
  body { -webkit-app-region: drag; user-select: none; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .bar { position: fixed; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 6px; padding: 5px 6px 14px 10px;
         background: linear-gradient(rgba(0,0,0,.75), transparent); opacity: .9; }
  .bar span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-shadow: 0 1px 2px #000; }
  button { -webkit-app-region: no-drag; border: 0; border-radius: 6px; background: rgba(30,31,34,.85); color: #f2f3f5;
           font-size: 13px; padding: 3px 8px; cursor: pointer; }
  button:hover { background: #5865f2; }
  button.close:hover { background: #da373c; }
`;

/** Stream atual da conexão escolhida (null se parou de transmitir ou saí da call). */
function current(): { stream: MediaStream; name: string } | null {
  const s = app.state;
  const call = s.call;
  if (!call || !connId) return null;
  const p = s.calls[call.conversationId]?.participants.find((x) => x.connection_id === connId);
  if (!p?.screen_sharing) return null;
  const stream = connId === s.connectionId ? call.screen : (call.remotes().find((r) => r.connectionId === connId)?.screen ?? null);
  if (!stream) return null;
  const name = app.user(p.user_id)?.display_name ?? '';
  return { stream, name: connId === s.connectionId ? `${name} (você)` : name };
}

function sync(): void {
  if (!win || win.closed) return cleanup();
  const cur = current();
  if (!cur) return closeMini();
  if (video && video.srcObject !== cur.stream) video.srcObject = cur.stream;
  if (label) label.textContent = `🖥 ${cur.name}`;
}

function build(w: Window): void {
  const d = w.document;
  d.title = TITLE;
  const style = d.createElement('style');
  style.textContent = CSS;
  d.head.append(style);

  video = d.createElement('video');
  video.autoplay = true;
  video.muted = true; // o som da transmissão já toca na janela principal
  video.playsInline = true;

  const bar = d.createElement('div');
  bar.className = 'bar';
  label = d.createElement('span');
  const back = d.createElement('button');
  back.textContent = '⤢';
  back.title = 'Voltar para o app';
  back.onclick = () => {
    window.native.focusMain?.();
    closeMini();
  };
  const close = d.createElement('button');
  close.className = 'close';
  close.textContent = '✕';
  close.title = 'Fechar miniatura';
  close.onclick = () => closeMini();
  bar.append(label, back, close);
  d.body.append(video, bar);

  w.addEventListener('pagehide', () => cleanup());
}

/** Abre (ou troca) a miniatura para a tela transmitida por essa conexão. */
export function openMini(connectionId: string): void {
  connId = connectionId;
  if (!win || win.closed) {
    const w = window.open('', MINI_NAME, 'popup,width=480,height=270');
    if (!w) return app.toast('Não consegui abrir a miniatura.');
    win = w;
    build(w);
    unsubscribe = app.subscribe(sync);
  }
  sync();
}

export function closeMini(): void {
  const w = win;
  cleanup();
  if (w && !w.closed) w.close();
}

export function miniOpenFor(): string | null {
  return win && !win.closed ? connId : null;
}

function cleanup(): void {
  unsubscribe?.();
  unsubscribe = null;
  win = null;
  connId = null;
  video = null;
  label = null;
}
