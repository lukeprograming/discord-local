// Abas das conversas abertas. Cada aba mantém a conversa montada (rascunho, resposta,
// rolagem). Recolher tira da barra sem fechar; fechar é o X. Nenhuma das duas sai da
// call nem para a música — isso só pelos controles da call.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Hash, Minus, Volume2, X } from 'lucide-react';
import type { Conversation } from '../../../shared/protocol.ts';
import { app, useApp } from '../app.ts';
import { Avatar } from './common.tsx';

function TabIcon({ c }: { c: Conversation }) {
  const peer = app.directPeer(c);
  if (peer) return <Avatar user={peer} size={20} />;
  return <span className="tab-glyph">{c.type === 'ROOM' ? <Volume2 size={14} /> : <Hash size={14} />}</span>;
}

export function TabBar() {
  const s = useApp((s) => s);
  const [trayOpen, setTrayOpen] = useState(false);
  const trayRef = useRef<HTMLDivElement>(null);
  const conv = (id: string) => s.conversations.find((c) => c.id === id);
  const visible = s.tabs.filter((t) => !t.min && conv(t.id));
  const minimized = s.tabs.filter((t) => t.min && conv(t.id));

  // Ctrl+Tab / Ctrl+Shift+Tab passam pelas abas visíveis.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== 'Tab' || visible.length < 2) return;
      e.preventDefault();
      const i = visible.findIndex((t) => t.id === app.state.selected);
      const next = visible[(i + (e.shiftKey ? -1 : 1) + visible.length) % visible.length];
      app.select(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible.map((t) => t.id).join()]);

  useEffect(() => {
    if (!trayOpen) return;
    const onDown = (e: PointerEvent) => !trayRef.current?.contains(e.target as Node) && setTrayOpen(false);
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [trayOpen]);

  if (!visible.length && !minimized.length) return null;

  return (
    <nav className="tabbar" aria-label="Conversas abertas">
      <div className="tabs-scroll" role="tablist">
        {visible.map((t) => {
          const c = conv(t.id)!;
          const active = s.selected === t.id;
          const unread = s.unread[t.id] ?? 0;
          const call = s.calls[t.id]?.participants.length;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={`tab ${active ? 'active' : ''} ${unread ? 'has-unread' : ''}`}
              title={app.conversationTitle(c)}
              onClick={() => app.select(t.id)}
              onKeyDown={(e) => e.key === 'Enter' && app.select(t.id)}
              onAuxClick={(e) => e.button === 1 && app.closeTab(t.id)}
            >
              <TabIcon c={c} />
              <span className="tab-name">{app.conversationTitle(c)}</span>
              {!!call && <Volume2 size={13} className="tab-call" aria-label="call ativa" />}
              {unread > 0 && <span className={`badge ${app.isMuted(t.id) ? 'badge-muted' : ''}`}>{unread}</span>}
              <button
                className="tab-btn"
                title="Recolher (continua aberta)"
                aria-label={`Recolher ${app.conversationTitle(c)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  app.minimizeTab(t.id);
                }}
              >
                <Minus size={13} />
              </button>
              <button
                className="tab-btn"
                title="Fechar aba"
                aria-label={`Fechar ${app.conversationTitle(c)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  app.closeTab(t.id);
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
      {minimized.length > 0 && (
        <div className="tab-tray" ref={trayRef}>
          <button className={`tab-tray-btn ${trayOpen ? 'on' : ''}`} aria-expanded={trayOpen} onClick={() => setTrayOpen(!trayOpen)}>
            {minimized.length} {minimized.length === 1 ? 'recolhida' : 'recolhidas'}
            {minimized.some((t) => s.unread[t.id]) && <span className="tray-dot" aria-label="com mensagens novas" />}
            <ChevronDown size={14} />
          </button>
          {trayOpen && (
            <div className="tab-tray-pop">
              {minimized.map((t) => {
                const c = conv(t.id)!;
                return (
                  <div key={t.id} className="tray-row">
                    <button
                      className="tray-open"
                      onClick={() => {
                        setTrayOpen(false);
                        app.select(t.id);
                      }}
                    >
                      <TabIcon c={c} />
                      <span className="tab-name">{app.conversationTitle(c)}</span>
                      {!!s.unread[t.id] && <span className="badge">{s.unread[t.id]}</span>}
                    </button>
                    <button className="tab-btn" title="Fechar aba" aria-label={`Fechar ${app.conversationTitle(c)}`} onClick={() => app.closeTab(t.id)}>
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
