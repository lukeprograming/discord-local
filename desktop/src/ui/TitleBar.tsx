// Barra de título própria (janela sem moldura, Windows/Linux). Arrasta a janela,
// duplo clique maximiza. Quem preferir a do sistema troca nas Configurações.

import { Copy, MessagesSquare, Minus, Square, X } from 'lucide-react';
import { useApp } from '../app.ts';
import { useRecorder } from '../recorder.ts';
import { NotificationBell } from './Notifications.tsx';

export function TitleBar() {
  const version = useApp((s) => s.version);
  const maximized = useApp((s) => s.maximized);
  const loggedIn = useApp((s) => !!s.profile?.token);
  const sharing = useApp((s) => !!s.call?.screen);
  const rec = useRecorder();

  return (
    <header className="titlebar" onDoubleClick={() => window.native.winToggleMaximize?.()}>
      <span className="tb-logo" aria-hidden>
        <MessagesSquare size={15} />
      </span>
      <strong className="tb-name">Discord Local</strong>
      {version && <small className="tb-version">v{version}</small>}
      <span className="tb-drag" />
      {sharing && <span className="live-badge tb-pill">AO VIVO</span>}
      {rec.recording && <span className="rec-badge tb-pill">REC</span>}
      {loggedIn && <NotificationBell />}
      <div className="tb-win" onDoubleClick={(e) => e.stopPropagation()}>
        <button className="tb-btn" title="Minimizar" aria-label="Minimizar" onClick={() => window.native.winMinimize?.()}>
          <Minus size={16} />
        </button>
        <button
          className="tb-btn"
          title={maximized ? 'Restaurar' : 'Maximizar'}
          aria-label={maximized ? 'Restaurar' : 'Maximizar'}
          onClick={() => window.native.winToggleMaximize?.()}
        >
          {maximized ? <Copy size={14} /> : <Square size={13} />}
        </button>
        <button className="tb-btn close" title="Fechar" aria-label="Fechar" onClick={() => window.native.winClose?.()}>
          <X size={17} />
        </button>
      </div>
    </header>
  );
}

