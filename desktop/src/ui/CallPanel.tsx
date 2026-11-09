import { useEffect, useRef, useState } from 'react';
import {
  CircleDot,
  Dices,
  HeadphoneOff,
  Headphones,
  Maximize2,
  Megaphone,
  Mic,
  MicOff,
  Minimize2,
  MonitorOff,
  MonitorUp,
  Music,
  PhoneOff,
  Smartphone,
  Stethoscope,
  Video as VideoIcon,
  VideoOff,
  Volume2,
} from 'lucide-react';
import type { CallParticipant, Conversation } from '../../../shared/protocol.ts';
import { app, useApp, type PanelTab, type State } from '../app.ts';
import { SCREEN_PRESETS, type ScreenPreset } from '../rtc.ts';
import { Avatar } from './common.tsx';
import { openMini } from '../mini.ts';
import { sendFiles } from '../files.ts';
import { useMediaVideo } from './Media.tsx';
import { useIdle, useTileFullscreen } from './tile.tsx';
import { canRecord, saveClip, setVideoVolume, startClipBuffer, startRecording, stopClipBuffer, stopRecording, useRecorder, type Target } from '../recorder.ts';
import { hotkeyOf, prettyAccel } from '../hotkeys.ts';

/** Telas sendo transmitidas na call em que estou (minha e dos outros). */
export function callScreens(s: State): { p: CallParticipant; stream: MediaStream }[] {
  const session = s.call;
  if (!session) return [];
  const remotes = new Map(session.remotes().map((r) => [r.connectionId, r]));
  return (s.calls[session.conversationId]?.participants ?? [])
    .filter((p) => p.screen_sharing)
    .map((p) => ({
      p,
      stream: p.connection_id === s.connectionId ? session.screen : (remotes.get(p.connection_id)?.screen ?? null),
    }))
    .filter((x): x is { p: CallParticipant; stream: MediaStream } => !!x.stream);
}

/** Alvos de gravação/clipe da call atual: só o áudio, ou a tela de alguém. */
export function recordTargets(s: State): Target[] {
  return [
    { label: 'Só o áudio da call', stream: null },
    ...callScreens(s).map(({ p, stream }) => ({
      label: `Tela de ${app.user(p.user_id)?.display_name ?? '?'}${p.connection_id === s.connectionId ? ' (você)' : ''}`,
      stream,
    })),
  ];
}

/** Ferramentas da call: cada uma abre a aba dela no painel da direita. */
const TOOLS: { tab: PanelTab; label: string; Icon: typeof Music }[] = [
  { tab: 'music', label: 'Música (YouTube, Spotify, SoundCloud)', Icon: Music },
  { tab: 'games', label: 'Jogos (jogo da velha, quadro)', Icon: Dices },
  { tab: 'sounds', label: 'Soundboard', Icon: Megaphone },
  { tab: 'record', label: 'Gravar / clipes', Icon: CircleDot },
  { tab: 'diag', label: 'Diagnóstico (microfone e conexão)', Icon: Stethoscope },
];

export function CallPanel({ conversation }: { conversation: Conversation }) {
  const s = useApp((s) => s);
  const info = s.calls[conversation.id];
  const session = s.call?.conversationId === conversation.id ? s.call : null;
  const [shareOpen, setShareOpen] = useState(false);
  const recState = useRecorder();
  const video = useMediaVideo();
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
        <span className="compact-label">
          <Volume2 size={16} /> Call ativa
        </span>
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
  const screens = callScreens(s);
  const focusedScreen = screens.find((x) => x.p.connection_id === focused) ?? null;
  const media = info?.media;
  const bot = !!media?.queue.length && video && !focusedScreen;
  const stageOn = screens.length > 0 || bot;
  const tool = s.panelOpen ? s.panelTab : null;

  return (
    <>
    <div
      ref={panelRef}
      className={`call-panel ${stageOn ? 'with-screens' : ''} ${focusedScreen ? 'focused' : ''}`}
      style={stageOn && stage === 'normal' ? { height } : undefined}
    >
      {stageOn && (
        <div className="screens">
          {/* O player (Media.tsx) se posiciona por cima deste espaço. */}
          {bot && <div id="media-slot" className="screen-tile media-slot" />}
          {(focusedScreen ? [focusedScreen] : screens).map(({ p, stream }) => (
            <StreamTile
              key={p.connection_id}
              stream={stream}
              userId={p.user_id}
              mine={p.connection_id === s.connectionId}
              recording={!!p.recording}
              many={screens.length > 1}
              focused={!!focused}
              onFocus={() => setFocused(focused ? null : p.connection_id)}
              onMini={s.platform !== 'android' ? () => openMini(p.connection_id) : undefined}
            >
              {p.connection_id === s.connectionId && recState.video && <VideoShareControls el={recState.video.el} name={recState.video.name} />}
            </StreamTile>
          ))}
        </div>
      )}

      <div className="call-people">
        {participants.map((p) => {
          const me = p.connection_id === s.connectionId;
          const r = remotes.get(p.connection_id);
          const speaking = me ? session.localSpeaking : r?.speaking;
          const cam = me ? session.camera : (r?.camera ?? null);
          const name = app.user(p.user_id)?.display_name;
          return (
            <div
              key={p.connection_id}
              className={`call-person ${!me ? 'clickable' : ''} ${speaking ? 'speaking' : ''} ${cam ? 'with-cam' : ''}`}
              title={me ? undefined : `Clique para ajustar o volume${r ? ` — conexão: ${r.state}` : ''}`}
              onClick={me ? undefined : () => setVolumeFor(volumeFor === p.connection_id ? null : p.connection_id)}
            >
              {cam ? (
                <CamTile stream={cam} speaking={!!speaking} mirror={me} id={`cam-${p.connection_id}`} />
              ) : (
                <Avatar user={app.user(p.user_id)} size={56} speaking={speaking} />
              )}
              <span className="call-person-name">
                {conversation.owner_id === p.user_id && <span className="owner-crown" title="Dono">👑</span>}
                <span className="name-text">{name}</span>
                {p.muted && <MicOff size={14} className="state-icon" aria-label="microfone desligado" />}
                {p.deafened && <HeadphoneOff size={14} className="state-icon" aria-label="ensurdecido" />}
                {p.screen_sharing && <MonitorUp size={14} className="state-icon live" aria-label="transmitindo a tela" />}
                {p.recording && <span className="rec-badge" title="Está gravando a call">REC</span>}
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

      <div className="call-controls" role="toolbar" aria-label="Controles da call">
        <div className="ctrl-group">
          <button
            className={`round ${session.muted ? 'off' : ''}`}
            title={session.noMic ? 'Sem microfone — você está só ouvindo' : session.muted ? 'Ativar microfone' : 'Silenciar'}
            aria-label={session.muted ? 'Ativar microfone' : 'Silenciar'}
            aria-pressed={session.muted}
            disabled={session.noMic}
            onClick={() => app.toggleMute()}
          >
            {session.muted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
          <button
            className={`round ${session.deafened ? 'off' : ''}`}
            title={session.deafened ? 'Voltar a ouvir' : 'Ensurdecer'}
            aria-label={session.deafened ? 'Voltar a ouvir' : 'Ensurdecer'}
            aria-pressed={session.deafened}
            onClick={() => app.toggleDeafen()}
          >
            {session.deafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
          </button>
          {window.native.setSpeaker && (
            <button
              className={`round ${s.speaker ? 'on' : ''}`}
              title={s.speaker ? 'Alto-falante (tocar para usar o fone)' : 'Fone do celular (tocar para usar o alto-falante)'}
              aria-label="Alto-falante"
              aria-pressed={s.speaker}
              onClick={() => app.setSpeaker(!s.speaker)}
            >
              {s.speaker ? <Volume2 size={20} /> : <Smartphone size={20} />}
            </button>
          )}
          <button
            className={`round ${session.camera ? 'on' : ''}`}
            title={session.camera ? 'Desligar câmera' : 'Ligar câmera'}
            aria-label={session.camera ? 'Desligar câmera' : 'Ligar câmera'}
            aria-pressed={!!session.camera}
            onClick={() => app.toggleCamera()}
          >
            {session.camera ? <VideoIcon size={20} /> : <VideoOff size={20} />}
          </button>
          {!navigator.mediaDevices?.getDisplayMedia ? null : session.screen ? (
            <button className="round on" title="Parar transmissão" aria-label="Parar transmissão" onClick={() => app.stopScreen()}>
              <MonitorOff size={20} />
            </button>
          ) : (
            <button className="round" title="Transmitir tela" aria-label="Transmitir tela" onClick={() => setShareOpen(true)}>
              <MonitorUp size={20} />
            </button>
          )}
        </div>

        <div className="ctrl-group tools">
          {TOOLS.filter((t) => t.tab !== 'record' || canRecord()).map(({ tab, label, Icon }) => {
            const busy =
              (tab === 'music' && !!media?.queue.length) || (tab === 'record' && (!!recState.recording || !!recState.clip));
            return (
              <button
                key={tab}
                className={`round small ${tool === tab ? 'on' : ''} ${tab === 'record' && recState.recording ? 'red' : busy ? 'busy' : ''}`}
                title={label}
                aria-label={label}
                aria-pressed={tool === tab}
                onClick={() => app.openPanel(tab)}
              >
                <Icon size={18} />
              </button>
            );
          })}
        </div>

        <div className="ctrl-group">
          {stageOn && (
            <button
              className={`round small ${stage !== 'normal' ? 'on' : ''}`}
              title={stage === 'normal' ? 'Ampliar (esconde o chat)' : stage === 'wide' ? 'Ampliar mais (esconde a lateral)' : 'Voltar ao normal (Esc)'}
              aria-label="Tamanho do palco"
              onClick={() => app.setStage(stage === 'normal' ? 'wide' : stage === 'wide' ? 'theater' : 'normal')}
            >
              {stage === 'theater' ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
          )}
          <button className="round red leave" title="Sair da call" aria-label="Sair da call" onClick={() => app.leaveCall()}>
            <PhoneOff size={20} />
          </button>
        </div>
      </div>

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
  const [source, setSource] = useState<'screen' | 'file'>('screen');
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canFile = platform !== 'android' && 'captureStream' in HTMLVideoElement.prototype;
  // Linux: escolher de quais apps vai o som (vazio = o PC todo).
  const [onlySome, setOnlySome] = useState(false);
  const [apps, setApps] = useState<{ key: string; name: string; detail: string; voice?: boolean }[] | null>(null);
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
        <h3>Transmitir</h3>
        {canFile && (
          <div className="share-source">
            <button className={source === 'screen' ? 'on' : ''} onClick={() => setSource('screen')}>🖥 Tela ou janela</button>
            <button className={source === 'file' ? 'on' : ''} onClick={() => setSource('file')}>🎞 Vídeo do PC</button>
          </div>
        )}
        {source === 'file' && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept="video/*,.mkv"
              hidden
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button className="pick-video" onClick={() => fileInput.current?.click()}>
              {file ? `🎞 ${file.name}` : 'Escolher arquivo de vídeo…'}
            </button>
            <small className="muted">Vai com o som do vídeo pra todos, sem o resto do PC. Você controla play/pausa/posição na sua tela.</small>
          </>
        )}
        <h4>Qualidade</h4>
        {(Object.keys(SCREEN_PRESETS) as ScreenPreset[]).map((k) => (
          <label key={k} className="check">
            <input type="radio" checked={preset === k} onChange={() => setPreset(k)} />
            {SCREEN_PRESETS[k].label} <small className="muted">~{SCREEN_PRESETS[k].bitrate / 1e6} Mbps por pessoa</small>
          </label>
        ))}
        {source === 'screen' && <h4>Conteúdo</h4>}
        {source === 'screen' && (
          <>
        <label className="check">
          <input type="radio" checked={hint === 'detail'} onChange={() => setHint('detail')} />
          Texto / código <small className="muted">prioriza nitidez</small>
        </label>
        <label className="check">
          <input type="radio" checked={hint === 'motion'} onChange={() => setHint('motion')} />
          Jogo / vídeo <small className="muted">prioriza fluidez</small>
        </label>
          </>
        )}
        {source === 'screen' && (platform === 'win32' || platform === 'linux') && (
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
        {source === 'screen' && audio && canPick && (
          <div className="share-audio-apps">
            <label className="check">
              <input type="radio" checked={!onlySome} onChange={() => setOnlySome(false)} />
              Tudo que toca no PC
            </label>
            {!onlySome && (
              <label className="check sub-check">
                <input
                  type="checkbox"
                  checked={!!profile?.settings?.share_include_voice_apps}
                  onChange={(e) => app.saveSettings({ share_include_voice_apps: e.target.checked })}
                />
                incluir o Discord oficial <small className="muted">(desmarcado: as vozes da call do Discord não vazam na transmissão)</small>
              </label>
            )}
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
                    {(a as { voice?: boolean }).voice ? <small className="warn-text"> · app de voz (vozes da call)</small> : null}
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
            disabled={source === 'file' ? !file : !!audioApps && !audioApps.length}
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
              if (source === 'file' && file) app.startVideoShare(file, preset);
              else app.startScreen(preset, audio, hint, audioApps);
            }}
          >
            {source === 'file' ? 'Transmitir vídeo' : 'Escolher tela'}
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

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return '--:--';
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Controles do vídeo do PC que EU estou transmitindo (os outros só assistem). */
function VideoShareControls({ el, name }: { el: HTMLVideoElement; name: string }) {
  const [, redraw] = useState(0);
  const volume = useApp((s) => s.profile?.settings?.video_share_volume ?? 50);
  useEffect(() => {
    const t = window.setInterval(() => redraw((n) => n + 1), 500);
    const on = () => redraw((n) => n + 1);
    el.addEventListener('play', on);
    el.addEventListener('pause', on);
    return () => {
      clearInterval(t);
      el.removeEventListener('play', on);
      el.removeEventListener('pause', on);
    };
  }, [el]);
  return (
    <div className="bot-bar video-share-bar" onDoubleClick={(e) => e.stopPropagation()}>
      <button className="mini" title={el.paused ? 'Tocar' : 'Pausar'} onClick={() => (el.paused ? el.play() : el.pause())}>
        {el.paused ? '▶' : '❚❚'}
      </button>
      <span className="bot-title" title={name}>🎞 {name}</span>
      <small className="bot-time">
        {fmtTime(el.currentTime)} / {fmtTime(el.duration)}
      </small>
      <input
        className="bot-seek"
        type="range"
        min={0}
        max={Math.max(1, Math.floor(el.duration || 0))}
        value={Math.floor(el.currentTime)}
        onChange={(e) => {
          el.currentTime = Number(e.target.value);
          redraw((n) => n + 1);
        }}
      />
      <input
        className="bot-volume"
        type="range"
        min={0}
        max={100}
        value={volume}
        title={`Volume só pra você: ${volume}% (os outros recebem o som cheio)`}
        onChange={(e) => {
          const v = Number(e.target.value);
          setVideoVolume(v);
          app.saveSettings({ video_share_volume: v });
        }}
      />
    </div>
  );
}

export function RecordPanel({ targets, onClose }: { targets: Target[]; onClose?: () => void }) {
  const r = useRecorder();
  const clipKey = hotkeyOf(app.state.profile?.settings, 'clip');
  const [, redraw] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => redraw((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const fail = (e: unknown) => app.toast((e as Error).message);
  return (
    <div className="bot-panel record-panel">
      <div className="bot-panel-head">
        <strong>⏺ Gravar e clipes</strong>
        <small className="muted">os outros veem que você está gravando</small>
        {onClose && <button className="icon" title="Fechar" onClick={onClose}>✕</button>}
      </div>
      {r.recording ? (
        <div className="rec-row">
          <span className="rec-dot" /> Gravando <strong>{r.recording.label}</strong> — {fmtTime((Date.now() - r.recording.startedAt) / 1000)}
          <button className="mini" onClick={stopRecording}>⏹ parar e salvar</button>
        </div>
      ) : (
        <div className="rec-targets">
          {targets.map((t) => (
            <button key={t.label} className="mini" onClick={() => startRecording(t).catch(fail)}>
              ⏺ Gravar {t.label.charAt(0).toLowerCase() + t.label.slice(1)}
            </button>
          ))}
        </div>
      )}
      {r.lastRecording && !r.recording && (
        <small className="muted">
          Última gravação salva. <button className="link" onClick={() => window.native.recShow?.(r.lastRecording!)}>mostrar na pasta</button>
        </small>
      )}
      <hr />
      <div className="rec-row">
        <strong>🎬 Clipes</strong>
        <small className="muted">
          guarda sempre os últimos 30–60 s; {clipKey ? `${prettyAccel(clipKey)} salva` : 'defina a tecla nas Configurações'}
        </small>
      </div>
      {r.clip ? (
        <div className="rec-row">
          Guardando <strong>{r.clip.label}</strong>
          <button className="mini" onClick={() => saveClip().catch(fail)}>💾 salvar clipe agora</button>
          <button className="mini" onClick={stopClipBuffer}>desligar</button>
        </div>
      ) : (
        <div className="rec-targets">
          {targets.map((t) => (
            <button key={t.label} className="mini" onClick={() => startClipBuffer(t)}>
              🎬 Guardar clipes: {t.label.charAt(0).toLowerCase() + t.label.slice(1)}
            </button>
          ))}
        </div>
      )}
      {r.lastClip && (
        <div className="rec-row">
          <small className="muted">Último: {r.lastClip.name}</small>
          <button
            className="mini"
            onClick={() => {
              const conv = app.state.call?.conversationId;
              if (conv) sendFiles(conv, [new File([r.lastClip!.blob], r.lastClip!.name, { type: r.lastClip!.blob.type })]);
            }}
          >
            📤 mandar no chat
          </button>
          <button className="mini" onClick={() => window.native.recShow?.(r.lastClip!.path)}>mostrar na pasta</button>
        </div>
      )}
    </div>
  );
}

/** Tela transmitida: nome no topo, ações à direita, tela cheia com duplo clique ou ⛶. */
function StreamTile({
  stream,
  userId,
  mine,
  recording,
  many,
  focused,
  onFocus,
  onMini,
  children,
}: {
  stream: MediaStream;
  userId: string;
  mine: boolean;
  recording: boolean;
  many: boolean;
  focused: boolean;
  onFocus: () => void;
  onMini?: () => void;
  children?: React.ReactNode;
}) {
  const { ref, idle } = useIdle();
  const { fs, toggle } = useTileFullscreen(`screen-${userId}`);
  const name = app.user(userId)?.display_name ?? '?';
  const vol = useApp((s) => s.profile?.settings?.user_volumes?.[userId]?.screen ?? 1);
  const hasAudio = stream.getAudioTracks().length > 0;
  const [size, setSize] = useState('');
  useEffect(() => {
    const t = window.setInterval(() => {
      const v = ref.current?.querySelector('video');
      if (v?.videoWidth) setSize(`${v.videoHeight}p`);
    }, 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <div ref={ref} className={`screen-tile stream-tile ${idle ? 'idle' : ''} ${fs ? 'tile-fs' : ''}`} onDoubleClick={toggle}>
      <Video stream={stream} muted />
      <div className="tile-top">
        <span className="live-badge">AO VIVO</span>
        {recording && <span className="rec-badge">⏺ REC</span>}
        <strong>
          {name}
          {mine && ' (você)'}
        </strong>
        {size && <small className="muted">{size}</small>}
      </div>
      <div className="tile-actions" onDoubleClick={(e) => e.stopPropagation()}>
        {!mine && hasAudio && (
          <label className="tile-vol" title={`Volume do som da transmissão: ${Math.round(vol * 100)}%`}>
            🔊
            <input type="range" min={0} max={2} step={0.05} value={vol} onChange={(e) => app.setUserVolume(userId, 'screen', Number(e.target.value))} />
          </label>
        )}
        {many && (
          <button className="tile-btn" title={focused ? 'Ver todas as telas' : 'Ver só esta tela'} onClick={onFocus}>
            {focused ? '▦' : '👁'}
          </button>
        )}
        {onMini && (
          <button className="tile-btn" title="Miniatura sempre por cima dos outros apps" onClick={onMini}>
            🗗
          </button>
        )}
        <button className="tile-btn" title={fs ? 'Sair da tela cheia (Esc)' : 'Tela cheia (duplo clique; Esc sai)'} onClick={toggle}>
          {fs ? '🗙' : '⛶'}
        </button>
      </div>
      {children}
    </div>
  );
}

/** Câmera: o quadro segue o formato do vídeo (em pé ou deitado) e mostra a imagem inteira. */
function CamTile({ stream, speaking, mirror, id }: { stream: MediaStream; speaking: boolean; mirror: boolean; id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { fs, toggle } = useTileFullscreen(id);
  const [aspect, setAspect] = useState(16 / 9);
  useEffect(() => {
    const v = ref.current?.querySelector('video');
    if (!v) return;
    const update = () => v.videoWidth && v.videoHeight && setAspect(v.videoWidth / v.videoHeight);
    v.addEventListener('loadedmetadata', update);
    v.addEventListener('resize', update); // celular girou
    update();
    return () => {
      v.removeEventListener('loadedmetadata', update);
      v.removeEventListener('resize', update);
    };
  }, [stream]);
  const portrait = aspect < 1;
  return (
    <div
      ref={ref}
      className={`cam-tile ${portrait ? 'portrait' : ''} ${speaking ? 'speaking' : ''} ${mirror ? 'mirror' : ''} ${fs ? 'cam-fs' : ''}`}
      style={{ aspectRatio: String(aspect) }}
      title="Clique duas vezes para tela cheia"
      onDoubleClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
    >
      <Video stream={stream} muted />
      {fs && (
        <button className="tile-btn cam-fs-close" title="Sair da tela cheia (Esc)" onClick={toggle}>
          🗙
        </button>
      )}
    </div>
  );
}
