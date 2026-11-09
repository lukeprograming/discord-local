// "Na call": fica no pé da lateral enquanto estou numa call, em qualquer tela.
// Mostra onde estou, se estou transmitindo/gravando, e os controles essenciais.

import { HeadphoneOff, Headphones, Mic, MicOff, PhoneOff, Signal } from 'lucide-react';
import { app, useApp } from '../app.ts';
import { useRecorder } from '../recorder.ts';

export function CallDock() {
  // A CallSession muda por dentro (mesma referência): seleciona os valores, não o objeto.
  const callId = useApp((s) => s.call?.conversationId ?? null);
  const muted = useApp((s) => !!s.call?.muted);
  const deafened = useApp((s) => !!s.call?.deafened);
  const noMic = useApp((s) => !!s.call?.noMic);
  const sharing = useApp((s) => !!s.call?.screen);
  const conv = useApp((s) => s.conversations.find((c) => c.id === s.call?.conversationId));
  const here = useApp((s) => s.selected === s.call?.conversationId);
  const people = useApp((s) => (s.call ? (s.calls[s.call.conversationId]?.participants.length ?? 0) : 0));
  const rec = useRecorder();
  if (!callId) return null;

  return (
    <div className="call-dock">
      <button className="dock-where" title={here ? undefined : 'Ir para a call'} onClick={() => app.select(callId)}>
        <span className="dock-status">
          <Signal size={14} /> Na call
          {sharing && <span className="live-badge">AO VIVO</span>}
          {rec.recording && <span className="rec-badge">REC</span>}
        </span>
        <small className="muted">
          {conv ? app.conversationTitle(conv) : '…'} · {people} {people === 1 ? 'pessoa' : 'pessoas'}
        </small>
      </button>
      <button
        className={`dock-btn ${muted ? 'off' : ''}`}
        title={muted ? 'Ativar microfone' : 'Silenciar'}
        aria-label={muted ? 'Ativar microfone' : 'Silenciar'}
        disabled={noMic}
        onClick={() => app.toggleMute()}
      >
        {muted ? <MicOff size={17} /> : <Mic size={17} />}
      </button>
      <button
        className={`dock-btn ${deafened ? 'off' : ''}`}
        title={deafened ? 'Voltar a ouvir' : 'Ensurdecer'}
        aria-label={deafened ? 'Voltar a ouvir' : 'Ensurdecer'}
        onClick={() => app.toggleDeafen()}
      >
        {deafened ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
      </button>
      <button className="dock-btn leave" title="Sair da call" aria-label="Sair da call" onClick={() => app.leaveCall()}>
        <PhoneOff size={17} />
      </button>
    </div>
  );
}
