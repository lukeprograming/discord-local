import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../../../shared/protocol.ts';
import { app, useApp } from '../app.ts';
import { SCREEN_PRESETS, type ScreenPreset } from '../rtc.ts';
import { Avatar } from './common.tsx';

export function CallPanel({ conversation }: { conversation: Conversation }) {
  const s = useApp((s) => s);
  const info = s.calls[conversation.id];
  const session = s.call?.conversationId === conversation.id ? s.call : null;
  const [shareOpen, setShareOpen] = useState(false);
  const [focused, setFocused] = useState<string | null>(null); // mostrar só a tela dessa conexão
  const stage = s.stage;
  const [height, setHeight] = useState(() => {
    try {
      return Number(localStorage.getItem('stage-height')) || Math.round(window.innerHeight * 0.6);
    } catch {
      return Math.round(window.innerHeight * 0.6);
    }
  });
  const panelRef = useRef<HTMLDivElement>(null);

  // Esc volta ao tamanho normal (fora da tela cheia, que o navegador já trata).
  useEffect(() => {
    if (stage === 'normal') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.fullscreenElement && app.setStage('normal');
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage]);

  function startResize(e: React.PointerEvent) {
    const top = panelRef.current?.getBoundingClientRect().top ?? 0;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      setHeight(Math.max(180, Math.min(window.innerHeight - 140, ev.clientY - top)));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setHeight((h) => {
        try {
          localStorage.setItem('stage-height', String(h));
        } catch {
          /* sem storage */
        }
        return h;
      });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  // Call ativa mas eu não estou nela.
  if (!session) {
    return (
      <div className="call-panel compact">
        <span>🔊 Call ativa</span>
        <div className="call-people">
          {info?.participants.map((p) => <Avatar key={p.connection_id} user={app.user(p.user_id)} size={28} />)}
        </div>
        <button className="primary" onClick={() => app.joinCall(conversation.id).catch((e) => app.toast(e.message))}>
          Entrar
        </button>
      </div>
    );
  }

  const remotes = new Map(session.remotes().map((r) => [r.connectionId, r]));
  const participants = info?.participants ?? [];
  const screens = participants
    .filter((p) => p.screen_sharing)
    .map((p) => ({
      p,
      stream: p.connection_id === s.connectionId ? session.screen : (remotes.get(p.connection_id)?.screen ?? null),
    }))
    .filter((x) => x.stream);
  const focusedScreen = screens.find((x) => x.p.connection_id === focused) ?? null;

  return (
    <>
    <div
      ref={panelRef}
      className={`call-panel ${screens.length ? 'with-screens' : ''} ${focusedScreen ? 'focused' : ''}`}
      style={screens.length && stage === 'normal' ? { height } : undefined}
    >
      {screens.length > 0 && (
        <div className="screens">
          {(focusedScreen ? [focusedScreen] : screens).map(({ p, stream }) => (
            <div
              key={p.connection_id}
              className="screen-tile"
              title="Clique duas vezes para ampliar"
              onDoubleClick={() => app.setStage(stage === 'normal' ? 'theater' : 'normal')}
            >
              <Video stream={stream!} muted />
              <div className="screen-label">
                🖥 {app.user(p.user_id)?.display_name}
                {p.connection_id === s.connectionId && ' (você)'}
                {screens.length > 1 && (
                  <button className="mini" onClick={() => setFocused(focused ? null : p.connection_id)}>
                    {focused ? 'ver todas' : 'só esta'}
                  </button>
                )}
                <button className="mini" onClick={(e) => (e.currentTarget.closest('.screen-tile') as HTMLElement)?.requestFullscreen()}>
                  tela cheia
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="call-people">
        {participants.map((p) => {
          const me = p.connection_id === s.connectionId;
          const r = remotes.get(p.connection_id);
          const speaking = me ? session.localSpeaking : r?.speaking;
          return (
            <div key={p.connection_id} className="call-person" title={r ? `conexão: ${r.state}` : undefined}>
              <Avatar user={app.user(p.user_id)} size={48} speaking={speaking} />
              <span>
                {app.user(p.user_id)?.display_name}
                {p.muted && ' 🔇'}
                {p.deafened && ' 🙉'}
                {p.screen_sharing && ' 🖥'}
              </span>
              {!me && r && r.state !== 'connected' && <small className="muted">{r.state === 'failed' ? 'falhou' : 'conectando…'}</small>}
            </div>
          );
        })}
        {participants.length === 1 && <div className="muted small">Chamando…</div>}
      </div>

      <div className="call-controls">
        <button className={`round ${session.muted ? 'off' : ''}`} title={session.muted ? 'Ativar microfone' : 'Silenciar'} onClick={() => app.toggleMute()}>
          {session.muted ? '🔇' : '🎙'}
        </button>
        <button className={`round ${session.deafened ? 'off' : ''}`} title={session.deafened ? 'Voltar a ouvir' : 'Ensurdecer'} onClick={() => app.toggleDeafen()}>
          {session.deafened ? '🙉' : '🎧'}
        </button>
        {session.screen ? (
          <button className="round on" title="Parar transmissão" onClick={() => app.stopScreen()}>
            ⏹
          </button>
        ) : (
          <button className="round" title="Transmitir tela" onClick={() => setShareOpen(true)}>
            🖥
          </button>
        )}
        {screens.length > 0 && (
          <button
            className={`round ${stage !== 'normal' ? 'on' : ''}`}
            title={stage === 'normal' ? 'Ampliar (esconde o chat)' : stage === 'wide' ? 'Ampliar mais (esconde a lateral)' : 'Voltar ao normal (Esc)'}
            onClick={() => app.setStage(stage === 'normal' ? 'wide' : stage === 'wide' ? 'theater' : 'normal')}
          >
            {stage === 'theater' ? '⤡' : '⤢'}
          </button>
        )}
        <button className="round red" title="Sair da call" onClick={() => app.leaveCall()}>
          ✆
        </button>
      </div>

      {s.callError && <div className="error">{s.callError}</div>}
      {shareOpen && <ShareOptions onClose={() => setShareOpen(false)} />}
    </div>
    {screens.length > 0 && stage === 'normal' && (
      <div className="stage-resizer" title="Arraste para aumentar ou diminuir" onPointerDown={startResize} />
    )}
    </>
  );
}

function ShareOptions({ onClose }: { onClose: () => void }) {
  const profile = useApp((s) => s.profile);
  const platform = useApp((s) => s.platform);
  const [preset, setPreset] = useState<ScreenPreset>((profile?.settings?.screen_preset as ScreenPreset) ?? '1080p30');
  const [hint, setHint] = useState<'detail' | 'motion'>('detail');
  const [audio, setAudio] = useState(false);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Transmitir tela</h3>
        <h4>Qualidade</h4>
        {(Object.keys(SCREEN_PRESETS) as ScreenPreset[]).map((k) => (
          <label key={k} className="check">
            <input type="radio" checked={preset === k} onChange={() => setPreset(k)} />
            {SCREEN_PRESETS[k].label} <small className="muted">~{SCREEN_PRESETS[k].bitrate / 1e6} Mbps por pessoa</small>
          </label>
        ))}
        <h4>Conteúdo</h4>
        <label className="check">
          <input type="radio" checked={hint === 'detail'} onChange={() => setHint('detail')} />
          Texto / código <small className="muted">prioriza nitidez</small>
        </label>
        <label className="check">
          <input type="radio" checked={hint === 'motion'} onChange={() => setHint('motion')} />
          Jogo / vídeo <small className="muted">prioriza fluidez</small>
        </label>
        {platform === 'win32' && (
          <label className="check">
            <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
            Transmitir o áudio do PC <small className="muted">(use fone, senão os outros ouvem o próprio eco)</small>
          </label>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Cancelar</button>
          <button
            className="primary"
            onClick={() => {
              onClose();
              app.startScreen(preset, audio, hint);
            }}
          >
            Escolher tela
          </button>
        </div>
      </div>
    </div>
  );
}

function Video({ stream, muted }: { stream: MediaStream; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}
