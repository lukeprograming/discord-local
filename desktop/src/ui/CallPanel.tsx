import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../../../shared/protocol.ts';
import { app, useApp } from '../app.ts';
import { SCREEN_PRESETS, type ScreenPreset } from '../rtc.ts';
import { Avatar } from './common.tsx';
import { openMini } from '../mini.ts';
import { BotPanel, BotPlayer } from './YouTubeBot.tsx';

export function CallPanel({ conversation }: { conversation: Conversation }) {
  const s = useApp((s) => s);
  const info = s.calls[conversation.id];
  const session = s.call?.conversationId === conversation.id ? s.call : null;
  const [shareOpen, setShareOpen] = useState(false);
  const [botOpen, setBotOpen] = useState(false);
  const [focused, setFocused] = useState<string | null>(null); // mostrar só a tela dessa conexão
  const [volumeFor, setVolumeFor] = useState<string | null>(null); // conexão com o popup de volume aberto
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
  const media = info?.media;
  const bot = !!media?.queue.length && !focusedScreen;
  const stageOn = screens.length > 0 || bot;

  return (
    <>
    <div
      ref={panelRef}
      className={`call-panel ${stageOn ? 'with-screens' : ''} ${focusedScreen ? 'focused' : ''}`}
      style={stageOn && stage === 'normal' ? { height } : undefined}
    >
      {stageOn && (
        <div className="screens">
          {bot && <BotPlayer media={media!} />}
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
                {s.platform !== 'android' && (
                  <button className="mini" title="Janelinha sempre por cima dos outros apps" onClick={() => openMini(p.connection_id)}>
                    miniatura
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
          const cam = me ? session.camera : (r?.camera ?? null);
          return (
            <div
              key={p.connection_id}
              className={`call-person ${!me ? 'clickable' : ''}`}
              title={me ? undefined : `Clique para ajustar o volume${r ? ` — conexão: ${r.state}` : ''}`}
              onClick={me ? undefined : () => setVolumeFor(volumeFor === p.connection_id ? null : p.connection_id)}
            >
              {cam ? (
                <div
                  className={`cam-tile ${speaking ? 'speaking' : ''} ${me ? 'mirror' : ''}`}
                  title="Clique duas vezes para tela cheia"
                  onDoubleClick={(e) => (e.currentTarget as HTMLElement).requestFullscreen()}
                >
                  <Video stream={cam} muted />
                </div>
              ) : (
                <Avatar user={app.user(p.user_id)} size={48} speaking={speaking} />
              )}
              <span>
                {app.user(p.user_id)?.display_name}
                {p.muted && ' 🔇'}
                {p.deafened && ' 🙉'}
                {p.screen_sharing && ' 🖥'}
              </span>
              {!me && r && r.state !== 'connected' && <small className="muted">{r.state === 'failed' ? 'falhou' : 'conectando…'}</small>}
              {volumeFor === p.connection_id && (
                <VolumePopover userId={p.user_id} sharing={p.screen_sharing} onClose={() => setVolumeFor(null)} />
              )}
            </div>
          );
        })}
        {participants.length === 1 && <div className="muted small">Chamando…</div>}
      </div>

      <div className="call-controls">
        <button
          className={`round ${session.muted ? 'off' : ''}`}
          title={session.noMic ? 'Sem microfone — você está só ouvindo' : session.muted ? 'Ativar microfone' : 'Silenciar'}
          disabled={session.noMic}
          onClick={() => app.toggleMute()}
        >
          {session.muted ? '🔇' : '🎙'}
        </button>
        <button className={`round ${session.deafened ? 'off' : ''}`} title={session.deafened ? 'Voltar a ouvir' : 'Ensurdecer'} onClick={() => app.toggleDeafen()}>
          {session.deafened ? '🙉' : '🎧'}
        </button>
        {window.native.setSpeaker && (
          <button className={`round ${s.speaker ? 'on' : ''}`} title={s.speaker ? 'Alto-falante (tocar para usar o fone)' : 'Fone do celular (tocar para usar o alto-falante)'} onClick={() => app.setSpeaker(!s.speaker)}>
            {s.speaker ? '🔊' : '📱'}
          </button>
        )}
        <button className={`round ${session.camera ? 'on' : ''}`} title={session.camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={() => app.toggleCamera()}>
          📷
        </button>
        {!navigator.mediaDevices?.getDisplayMedia ? null : session.screen ? (
          <button className="round on" title="Parar transmissão" onClick={() => app.stopScreen()}>
            ⏹
          </button>
        ) : (
          <button className="round" title="Transmitir tela" onClick={() => setShareOpen(true)}>
            🖥
          </button>
        )}
        <button className={`round ${botOpen || media?.queue.length ? 'on' : ''}`} title="Bot do YouTube (vídeo/música juntos)" onClick={() => setBotOpen(!botOpen)}>
          🎵
        </button>
        {stageOn && (
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

      {botOpen && <BotPanel media={media} onClose={() => setBotOpen(false)} />}
      {s.callError && <div className="error">{s.callError}</div>}
      {shareOpen && <ShareOptions onClose={() => setShareOpen(false)} />}
    </div>
    {stageOn && stage === 'normal' && (
      <div className="stage-resizer" title="Arraste para aumentar ou diminuir" onPointerDown={startResize} />
    )}
    </>
  );
}

function VolumePopover({ userId, sharing, onClose }: { userId: string; sharing: boolean; onClose: () => void }) {
  useApp((s) => s.profile?.settings?.user_volumes?.[userId]); // redesenha quando muda
  const mobile = useApp((s) => s.platform === 'android');
  const max = mobile ? 100 : 200; // no celular o som sai pelo <audio>, que não passa de 100%
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // Clique no próprio card da pessoa já fecha pelo toggle.
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const row = (kind: 'voice' | 'screen', label: string) => {
    const v = Math.round(app.userVolume(userId, kind) * 100);
    return (
      <label>
        <span>
          {label} <small className="muted">{Math.min(v, max)}%</small>
          {v !== 100 && (
            <button className="link" onClick={() => app.setUserVolume(userId, kind, 1)}>
              100%
            </button>
          )}
        </span>
        <input type="range" min={0} max={max} step={5} value={Math.min(v, max)} onChange={(e) => app.setUserVolume(userId, kind, Number(e.target.value) / 100)} />
      </label>
    );
  };

  return (
    <div ref={ref} className="volume-popover" onClick={(e) => e.stopPropagation()}>
      <strong>{app.user(userId)?.display_name}</strong>
      {row('voice', '🎙 Voz')}
      {row('screen', '🖥 Áudio da transmissão')}
      {!sharing && <small className="muted">O áudio da transmissão vale quando essa pessoa transmitir a tela com som.</small>}
    </div>
  );
}

function ShareOptions({ onClose }: { onClose: () => void }) {
  const profile = useApp((s) => s.profile);
  const platform = useApp((s) => s.platform);
  const [preset, setPreset] = useState<ScreenPreset>((profile?.settings?.screen_preset as ScreenPreset) ?? '1080p30');
  const [hint, setHint] = useState<'detail' | 'motion'>('detail');
  const [audio, setAudio] = useState(false);
  // Linux: escolher de quais apps vai o som (vazio = o PC todo).
  const [onlySome, setOnlySome] = useState(false);
  const [apps, setApps] = useState<{ key: string; name: string; detail: string }[] | null>(null);
  const [chosen, setChosen] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('share-audio-apps') || '[]');
    } catch {
      return [];
    }
  });
  const canPick = platform === 'linux' && !!window.native.shareAudioApps;

  function loadApps() {
    window.native.shareAudioApps?.().then(setApps).catch(() => setApps([]));
  }
  useEffect(() => {
    if (audio && onlySome && canPick && apps === null) loadApps();
  }, [audio, onlySome]);

  // Os escolhidos antes que não estão tocando agora continuam valendo (ex.: o jogo ainda vai abrir).
  const listed = apps ?? [];
  const extra = chosen.filter((k) => !listed.some((a) => a.key === k)).map((k) => ({ key: k, name: k, detail: 'não está tocando agora' }));
  const audioApps = audio && onlySome && canPick ? chosen : undefined;

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
        {(platform === 'win32' || platform === 'linux') && (
          <label className="check">
            <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
            Transmitir o áudio do PC{' '}
            <small className="muted">
              {platform === 'win32'
                ? '(use fone, senão os outros ouvem o próprio eco)'
                : '(sem as vozes da call)'}
            </small>
          </label>
        )}
        {audio && canPick && (
          <div className="share-audio-apps">
            <label className="check">
              <input type="radio" checked={!onlySome} onChange={() => setOnlySome(false)} />
              Tudo que toca no PC
            </label>
            <label className="check">
              <input type="radio" checked={onlySome} onChange={() => setOnlySome(true)} />
              Só os apps que eu escolher
            </label>
            {onlySome && (
              <div className="app-list">
                {apps === null && <small className="muted">Procurando apps…</small>}
                {apps !== null && !listed.length && !extra.length && (
                  <small className="muted">Nenhum app tocando som agora. Dê play em algo e atualize.</small>
                )}
                {[...listed, ...extra].map((a) => (
                  <label key={a.key} className="check">
                    <input
                      type="checkbox"
                      checked={chosen.includes(a.key)}
                      onChange={(e) =>
                        setChosen((c) => (e.target.checked ? [...c, a.key] : c.filter((k) => k !== a.key)))
                      }
                    />
                    {a.name} {a.detail && <small className="muted">{a.detail}</small>}
                  </label>
                ))}
                <button className="link" onClick={loadApps}>↻ atualizar lista</button>
              </div>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Cancelar</button>
          <button
            className="primary"
            disabled={!!audioApps && !audioApps.length}
            title={audioApps && !audioApps.length ? 'Escolha pelo menos um app' : undefined}
            onClick={() => {
              if (audioApps) {
                try {
                  localStorage.setItem('share-audio-apps', JSON.stringify(audioApps));
                } catch {
                  /* sem storage */
                }
              }
              onClose();
              app.startScreen(preset, audio, hint, audioApps);
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
