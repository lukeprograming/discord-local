import { useEffect, useState } from 'react';
import { app, useApp } from '../app.ts';
import type { ScreenSource } from '../native.d.ts';
import { Setup } from './Setup.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Chat } from './Chat.tsx';
import { CallPanel } from './CallPanel.tsx';
import { Avatar } from './common.tsx';

export function App() {
  const s = useApp((s) => s);
  if (!s.booted) return null;
  if (!s.profile?.token) return <Setup />;

  const selected = s.conversations.find((c) => c.id === s.selected) ?? null;
  const inThisCall = s.call && selected && s.call.conversationId === selected.id;
  // Ampliar só vale enquanto alguém transmite nessa call.
  const sharing = !!inThisCall && !!s.calls[selected!.id]?.participants.some((p) => p.screen_sharing);
  const stage = sharing ? s.stage : 'normal';

  return (
    <div className={`layout stage-${stage}`}>
      {stage !== 'theater' && <Sidebar />}
      <main className="main">
        {selected ? (
          <>
            {(inThisCall || s.calls[selected.id]) && <CallPanel conversation={selected} />}
            {stage === 'normal' && <Chat conversation={selected} />}
          </>
        ) : (
          <div className="empty">
            <h2>Bem-vindo, {s.profile.user.display_name}</h2>
            <p className="muted">Escolha uma conversa na lateral, ou adicione um amigo pelo nome de usuário.</p>
          </div>
        )}
      </main>
      <IncomingCall />
      <ScreenPicker />
      {s.toast && <div className="toast">{s.toast}</div>}
    </div>
  );
}

function IncomingCall() {
  const ringing = useApp((s) => s.ringing);
  const conversations = useApp((s) => s.conversations);

  // Toque simples gerado na hora, repetindo enquanto tocar.
  useEffect(() => {
    if (!ringing) return;
    const ctx = new AudioContext();
    const beep = () => {
      for (const [i, f] of [660, 880].entries()) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.08, ctx.currentTime + i * 0.25);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.25 + 0.22);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.25);
        o.stop(ctx.currentTime + i * 0.25 + 0.25);
      }
    };
    beep();
    const t = setInterval(beep, 2000);
    return () => {
      clearInterval(t);
      ctx.close();
    };
  }, [ringing]);

  if (!ringing) return null;
  const conv = conversations.find((c) => c.id === ringing.conversation_id);
  const from = app.user(ringing.from_user_id);
  return (
    <div className="incoming">
      <Avatar user={from} size={56} />
      <div>
        <strong>{from?.display_name ?? 'Alguém'}</strong>
        <div className="muted">{conv?.type === 'GROUP' ? `ligando em ${app.conversationTitle(conv)}` : 'está ligando'}</div>
      </div>
      <div className="incoming-actions">
        <button
          className="round green"
          title="Atender"
          onClick={() => {
            app.select(ringing.conversation_id);
            app.joinCall(ringing.conversation_id).catch((e) => app.toast(e.message));
          }}
        >
          ✆
        </button>
        <button className="round red" title="Recusar" onClick={() => app.declineCall()}>
          ✕
        </button>
      </div>
    </div>
  );
}

/** Seletor de tela/janela para Windows e X11 (no Wayland o sistema mostra o dele). */
function ScreenPicker() {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  useEffect(() => window.native.onChooseScreen(setSources), []);
  if (!sources) return null;

  const pick = (id: string | null) => {
    window.native.screenPicked(id);
    setSources(null);
  };
  const screens = sources.filter((s) => s.isScreen);
  const windows = sources.filter((s) => !s.isScreen);

  return (
    <div className="modal-backdrop" onClick={() => pick(null)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>O que você quer transmitir?</h3>
        {[
          ['Telas', screens],
          ['Janelas', windows],
        ].map(([title, list]) =>
          (list as ScreenSource[]).length ? (
            <div key={title as string}>
              <h4>{title as string}</h4>
              <div className="source-grid">
                {(list as ScreenSource[]).map((s) => (
                  <button key={s.id} className="source" onClick={() => pick(s.id)}>
                    <img src={s.thumbnail} alt="" />
                    <span>{s.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null,
        )}
        <div className="modal-actions">
          <button onClick={() => pick(null)}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}
