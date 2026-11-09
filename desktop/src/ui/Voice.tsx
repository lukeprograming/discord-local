import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, SendHorizontal, Trash2 } from 'lucide-react';
import { MAX_VOICE_BASE64, MAX_VOICE_MS, VOICE_PEAKS, type VoiceAttachment } from '../../../shared/protocol.ts';
import { app, useApp } from '../app.ts';

const MIN_VOICE_MS = 600;
const BITRATE = 24_000;

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function pickMime(): string {
  const options = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Resume os níveis gravados (um a cada 100 ms) em VOICE_PEAKS barras de 0 a 1. */
function summarizePeaks(levels: number[]): number[] {
  if (!levels.length) return [];
  const out: number[] = [];
  const n = Math.min(VOICE_PEAKS, levels.length);
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * levels.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / n));
    out.push(Math.max(...levels.slice(from, to)));
  }
  const max = Math.max(...out, 0.02);
  return out.map((v) => Math.round(Math.min(1, v / max) * 100) / 100);
}

type Recording = {
  stop(send: boolean): void;
};

/** Gravador do chat: botão de microfone que vira uma barra "gravando" com cancelar/enviar. */
export function VoiceRecorder({ conversationId, onRecording }: { conversationId: string; onRecording: (on: boolean) => void }) {
  const micId = useApp((s) => s.profile?.settings?.mic_id);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const rec = useRef<Recording | null>(null);

  useEffect(() => () => rec.current?.stop(false), []);
  // Trocou de conversa no meio da gravação: descarta.
  useEffect(() => () => rec.current?.stop(false), [conversationId]);

  async function start() {
    if (rec.current) return;
    if (typeof MediaRecorder === 'undefined') return app.toast('Este aparelho não grava áudio.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micId ? { ideal: micId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      return app.toast(`Não consegui abrir o microfone: ${(e as Error).message}`);
    }

    const mime = pickMime();
    const recorder = new MediaRecorder(stream, { ...(mime && { mimeType: mime }), audioBitsPerSecond: BITRATE });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const levels: number[] = [];
    const startedAt = performance.now();

    const tick = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      levels.push(rms);
      setLevel(Math.min(1, rms * 6));
      const ms = performance.now() - startedAt;
      setElapsed(ms);
      if (ms >= MAX_VOICE_MS) rec.current?.stop(true);
    }, 100);

    let done = false;
    rec.current = {
      stop(send) {
        if (done) return;
        done = true;
        rec.current = null;
        clearInterval(tick);
        const duration = performance.now() - startedAt;
        recorder.onstop = async () => {
          for (const t of stream.getTracks()) t.stop();
          ctx.close();
          if (!send) return;
          if (duration < MIN_VOICE_MS) return app.toast('Áudio curto demais.');
          const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
          const data = await blobToBase64(blob);
          if (data.length > MAX_VOICE_BASE64) return app.toast('Áudio grande demais.');
          app.sendVoice(conversationId, {
            kind: 'voice',
            mime: (recorder.mimeType || mime || 'audio/webm').slice(0, 64),
            data,
            duration_ms: Math.min(Math.round(duration), MAX_VOICE_MS),
            peaks: summarizePeaks(levels),
          });
        };
        if (recorder.state !== 'inactive') recorder.stop();
        else recorder.onstop(new Event('stop'));
        setElapsed(null);
        setLevel(0);
        onRecording(false);
      },
    };
    recorder.start(250);
    setElapsed(0);
    onRecording(true);
  }

  if (elapsed === null) {
    return (
      <button className="send-btn voice-btn" title="Gravar mensagem de voz" aria-label="Gravar mensagem de voz" onMouseDown={(e) => e.preventDefault()} onClick={start}>
        <Mic size={19} />
      </button>
    );
  }
  return (
    <div className="voice-recording">
      <button className="icon" title="Descartar" aria-label="Descartar áudio" onClick={() => rec.current?.stop(false)}>
        <Trash2 size={18} />
      </button>
      <span className="rec-dot" style={{ transform: `scale(${1 + level * 0.8})` }} />
      <span className="rec-time">{formatDuration(elapsed)}</span>
      <span className="muted small">gravando… (máx. {formatDuration(MAX_VOICE_MS)})</span>
      <button className="send-btn" title="Enviar áudio" aria-label="Enviar áudio" onClick={() => rec.current?.stop(true)}>
        <SendHorizontal size={18} />
      </button>
    </div>
  );
}

let playingNow: HTMLAudioElement | null = null; // só um áudio tocando por vez
const SPEEDS = [1, 1.5, 2];

/** Player da mensagem de voz: play/pausa, forma de onda com progresso e velocidade. */
export function VoiceMessage({ attachment }: { attachment: VoiceAttachment }) {
  const speakerId = useApp((s) => s.profile?.settings?.speaker_id);
  const url = useMemo(() => {
    const bin = atob(attachment.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: attachment.mime }));
  }, [attachment.data, attachment.mime]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0); // ms
  const [speed, setSpeed] = useState(1);
  const total = attachment.duration_ms;

  useEffect(() => {
    const el = audio.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (speakerId) el?.setSinkId?.(speakerId).catch(() => {});
  }, [speakerId, url]);

  // Progresso suave enquanto toca.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      if (audio.current) setPos(audio.current.currentTime * 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  function toggle() {
    const el = audio.current;
    if (!el) return;
    if (!el.paused) return el.pause();
    if (playingNow && playingNow !== el) playingNow.pause();
    playingNow = el;
    el.playbackRate = speed;
    el.play().catch((e) => app.toast(`Não consegui tocar o áudio: ${(e as Error).message}`));
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const el = audio.current;
    if (!el) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    el.currentTime = (frac * total) / 1000;
    setPos(frac * total);
  }

  function cycleSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audio.current) audio.current.playbackRate = next;
  }

  const progress = total ? Math.min(1, pos / total) : 0;
  const peaks = attachment.peaks.length ? attachment.peaks : Array(24).fill(0.3);

  return (
    <div className="voice-msg">
      <audio
        ref={audio}
        src={url}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPos(0);
          if (audio.current) audio.current.currentTime = 0;
        }}
      />
      <button className="voice-play" title={playing ? 'Pausar' : 'Ouvir'} onClick={toggle}>
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="voice-wave" onClick={seek} title="Clique para pular">
        {peaks.map((p, i) => (
          <span
            key={i}
            className={(i + 0.5) / peaks.length <= progress ? 'played' : ''}
            style={{ height: `${Math.max(12, p * 100)}%` }}
          />
        ))}
      </div>
      <span className="voice-time muted small">{formatDuration(playing || pos ? pos : total)}</span>
      <button className="voice-speed" title="Velocidade" onClick={cycleSpeed}>
        {speed}x
      </button>
    </div>
  );
}
