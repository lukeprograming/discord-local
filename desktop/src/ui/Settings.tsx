import { useEffect, useRef, useState } from 'react';
import { app, errorMessage, micSettings, useApp } from '../app.ts';
import { accelFromEvent, hotkeyOf, prettyAccel } from '../hotkeys.ts';
import { MIC_SAMPLE_RATE, MicProcessor, micConstraints, type NoiseMode } from '../mic.ts';
import { UpdateSection } from './Update.tsx';
import type { NetInterface } from '../native.d.ts';

export function Settings({ onClose }: { onClose: () => void }) {
  const profile = useApp((s) => s.profile)!;
  const mobile = useApp((s) => s.platform === 'android');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    // Os nomes dos dispositivos só aparecem depois da permissão de microfone.
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((st) => st.getTracks().forEach((t) => t.stop()))
      .catch(() => {})
      .finally(() => navigator.mediaDevices.enumerateDevices().then(setDevices));
  }, []);

  // A fonte virtual do áudio da transmissão (Linux) não é microfone de verdade.
  const inputs = devices.filter((d) => d.kind === 'audioinput' && !d.label.startsWith('Discord Local ('));
  const outputs = devices.filter((d) => d.kind === 'audiooutput');
  const cameras = devices.filter((d) => d.kind === 'videoinput');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Configurações</h3>
        <label>
          Microfone
          <select value={profile.settings?.mic_id ?? ''} onChange={(e) => app.saveSettings({ mic_id: e.target.value || undefined })}>
            <option value="">Padrão do sistema</option>
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
            ))}
          </select>
        </label>
        <label>
          Saída de áudio
          <select value={profile.settings?.speaker_id ?? ''} onChange={(e) => app.saveSettings({ speaker_id: e.target.value || undefined })}>
            <option value="">Padrão do sistema</option>
            {outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
            ))}
          </select>
        </label>
        <MicSection />
        {cameras.length > 0 && (
          <label>
            Câmera
            <select value={profile.settings?.camera_id ?? ''} onChange={(e) => app.saveSettings({ camera_id: e.target.value || undefined })}>
              <option value="">{mobile ? 'Frontal' : 'Padrão do sistema'}</option>
              {cameras.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Câmera ${i + 1}`}</option>
              ))}
            </select>
          </label>
        )}
        <p className="muted small">Trocar de dispositivo vale a partir da próxima call (volume e sensibilidade valem na hora).</p>
        {!mobile && (
          <>
            <hr />
            <HotkeySection />
          </>
        )}
        <hr />
        {profile.role === 'host' ? <HostSection /> : (
          <p className="small">
            Host: <code>{profile.server_url}</code>
          </p>
        )}
        <hr />
        <UpdateSection />
        <hr />
        <p className="small muted">Seu histórico fica salvo neste {mobile ? 'celular' : 'computador'}, na pasta de dados do app.</p>
        <div className="modal-actions">
          {!mobile && <button onClick={() => window.native.openDataDir()}>Abrir pasta de dados</button>}
          <button className="danger" onClick={() => { onClose(); app.logout(); }}>Sair da conta</button>
          <button className="primary" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}

const DB_MIN = -80;

const NOISE_OPTIONS: [NoiseMode, string][] = [
  ['gtcrn', 'IA (GTCRN) — padrão'],
  ['rnnoise', 'IA leve (RNNoise)'],
  ['native', 'Básica (do navegador)'],
  ['off', 'Desligada'],
];
const NOISE_HINT: Record<NoiseMode, string> = {
  gtcrn: 'Tira chiado, ventilador e barulho de fundo preservando a voz.',
  rnnoise: 'Mais antiga e mais leve; limpa menos. Use se o GTCRN pesar no aparelho.',
  native: 'O filtro simples do Chromium: tira só chiado leve.',
  off: 'Som cru do microfone (bom para música/instrumento).',
};

/** Volume e sensibilidade do microfone, com medidor ao vivo para achar o ponto certo. */
function MicSection() {
  const settings = useApp((s) => s.profile?.settings);
  const mic = micSettings(settings);
  const auto = mic.threshold === null;
  const [level, setLevel] = useState({ db: -100, open: true });
  const [error, setError] = useState('');
  const [noiseError, setNoiseError] = useState<string | null>(null);
  const [listen, setListen] = useState(false);
  const procRef = useRef<MicProcessor | null>(null);
  const listenRef = useRef(listen);
  listenRef.current = listen;

  // Captura própria para o medidor e para o "ouvir meu microfone" (nada é enviado).
  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE }) as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (settings?.speaker_id) ctx.setSinkId?.(settings.speaker_id).catch(() => {});
    const initial = micSettings(app.state.profile?.settings);
    navigator.mediaDevices
      .getUserMedia({ audio: micConstraints(settings?.mic_id, initial.noise) })
      .then(async (st) => {
        stream = st;
        if (stopped) return;
        const proc = await MicProcessor.create(ctx, st, initial);
        if (stopped) return proc.destroy();
        procRef.current = proc;
        if (!proc.hasGate) setError('Este aparelho não suporta o ajuste de sensibilidade.');
        proc.onLevel = (db, open) => setLevel({ db, open });
        proc.onNoiseChange = (_active, err) => setNoiseError(err);
        proc.monitor(listenRef.current);
      })
      .catch((e) => setError(`Sem microfone para testar: ${(e as Error).message}`));
    return () => {
      stopped = true;
      procRef.current?.destroy();
      procRef.current = null;
      for (const t of stream?.getTracks() ?? []) t.stop();
      ctx.close();
    };
  }, [settings?.mic_id, settings?.speaker_id]);

  useEffect(() => {
    procRef.current?.set(mic);
  }, [mic.volume, mic.threshold, mic.noise]);

  useEffect(() => {
    procRef.current?.monitor(listen);
  }, [listen]);

  const pct = (db: number) => `${Math.max(0, Math.min(100, ((db - DB_MIN) / -DB_MIN) * 100))}%`;
  const threshold = mic.threshold ?? -50;

  return (
    <>
      <label>
        Volume do microfone <small className="muted">{Math.round(mic.volume * 100)}%</small>
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(mic.volume * 100)}
          onChange={(e) => app.saveMicSettings({ mic_volume: Number(e.target.value) / 100 })}
        />
      </label>
      <label>
        Supressão de ruído
        <select value={mic.noise} onChange={(e) => app.saveMicSettings({ mic_noise: e.target.value as NoiseMode })}>
          {NOISE_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <small className="muted">{noiseError ?? NOISE_HINT[mic.noise]}</small>
      </label>
      <label className="check">
        <input type="checkbox" checked={listen} onChange={(e) => setListen(e.target.checked)} />
        Ouvir meu microfone <small className="muted">(use fone; é exatamente o que os outros recebem)</small>
      </label>
      <div className="mic-sensitivity">
        <span>Sensibilidade do microfone</span>
        <label className="check">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => app.saveMicSettings({ mic_threshold: e.target.checked ? null : threshold })}
          />
          Automática <small className="muted">(transmite sempre; o filtro de ruído do app limpa o fundo)</small>
        </label>
        <div className={`meter ${auto ? 'auto' : ''}`}>
          <div className={`meter-level ${level.open ? 'open' : ''}`} style={{ width: pct(level.db) }} />
          {!auto && <div className="meter-mark" style={{ left: pct(threshold) }} />}
        </div>
        {!auto && (
          <>
            <input
              type="range"
              min={DB_MIN}
              max={0}
              step={1}
              value={threshold}
              onChange={(e) => app.saveMicSettings({ mic_threshold: Number(e.target.value) })}
            />
            <small className="muted">
              {threshold} dB — fale normalmente: a barra deve ficar verde só quando você fala. Mais para a direita = precisa falar mais
              alto para ser ouvido.
            </small>
          </>
        )}
        {error && <small className="muted">{error}</small>}
      </div>
    </>
  );
}

function HostSection() {
  const profile = useApp((s) => s.profile)!;
  const online = useApp((s) => s.connection === 'online');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState('');
  useEffect(() => window.native.onExportProgress((p) => setDownloading(`Baixando o instalador base (${Math.round(p.size / 1e6)} MB) do GitHub…`)), []);

  async function exportFor(platform: 'win32' | 'linux', pickAgain = false) {
    setBusy(platform);
    setError('');
    setResult('');
    try {
      const file = await app.exportConnector(platform, pickAgain);
      if (file) setResult(file);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      setDownloading('');
    }
  }

  return (
    <>
      <h4>Seu servidor</h4>
      <p className="small">
        {profile.host?.name} — <code>{profile.server_url}</code>
      </p>
      <NetworkPicker />
      <h4>Convidar amigos</h4>
      <p className="muted small">
        Gera um instalador que já vem com o seu endereço e um convite: o amigo só instala e cria a conta.
        Você escolhe onde salvar.
      </p>
      <div className="export-row">
        <button disabled={!online || !!busy} onClick={() => exportFor('win32')}>
          {busy === 'win32' ? 'Gerando…' : '⬇ Instalador Windows'}
        </button>
        <button disabled={!online || !!busy} onClick={() => exportFor('linux')}>
          {busy === 'linux' ? 'Gerando…' : '⬇ Instalador Linux'}
        </button>
      </div>
      {!online && <p className="muted small">Inicie a sessão online para exportar.</p>}
      {downloading && busy && <p className="muted small">{downloading}</p>}
      {result && (
        <p className="small ok-text">
          Salvo em <code>{result}</code>
          <br />
          Mande esse arquivo para o seu amigo.
          <br />
          <button className="link" onClick={() => exportFor(result.endsWith('.exe') ? 'win32' : 'linux', true)}>
            gerar de novo a partir de outro instalador base
          </button>
        </p>
      )}
      {error && <div className="error">{error}</div>}
    </>
  );
}

/** Escolhe em qual VPN (IP) o servidor escuta. Amigos com instalador antigo precisam do endereço novo. */
function NetworkPicker() {
  const profile = useApp((s) => s.profile)!;
  const busy = useApp((s) => s.hostBusy);
  const current = profile.host!;
  const [ifaces, setIfaces] = useState<NetInterface[]>([]);
  const [ip, setIp] = useState(current.ip);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.native.interfaces().then(setIfaces);
  }, []);

  async function apply() {
    setError('');
    setSaved(false);
    const vpn = ifaces.find((i) => i.ip === ip)?.vpn;
    try {
      await app.updateHostConfig({ ...current, ip, tailscale: vpn === 'Tailscale' });
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <label>Rede (IP da VPN)</label>
      <div className="iface-list">
        {ifaces.map((i) => (
          <label key={i.ip} className="check">
            <input type="radio" checked={ip === i.ip} onChange={() => { setIp(i.ip); setSaved(false); }} />
            <span>
              <strong>{i.vpn}</strong> <code>{i.ip}</code> <small className="muted">{i.name}</small>
            </span>
          </label>
        ))}
        {!ifaces.some((i) => i.ip === current.ip) && (
          <label className="check">
            <input type="radio" checked={ip === current.ip} onChange={() => setIp(current.ip)} />
            <span><code>{current.ip}</code> <small className="muted">(atual, não encontrado agora)</small></span>
          </label>
        )}
      </div>
      {ip !== current.ip && (
        <button disabled={busy} onClick={apply}>{busy ? 'Reiniciando servidor…' : 'Usar esta rede'}</button>
      )}
      {saved && (
        <p className="small ok-text">
          Pronto. Seus amigos agora entram por <code>{profile.server_url}</code> — exporte o instalador de novo ou
          passe esse endereço para eles.
        </p>
      )}
      {error && <div className="error">{error}</div>}
    </>
  );
}

function HotkeySection() {
  const settings = useApp((s) => s.profile?.settings);
  const [kind, setKind] = useState<'kde' | 'basic' | null>(null);
  useEffect(() => {
    window.native.hotkeysKind?.().then(setKind);
  }, []);
  const ptt = settings?.voice_mode === 'ptt';

  async function save(patch: Parameters<typeof app.saveSettings>[0]) {
    await app.saveSettings(patch);
    if (app.state.call) await app.applyHotkeys();
  }

  return (
    <>
      <h4>Atalhos e modo de voz</h4>
      <label className="check">
        <input type="radio" checked={!ptt} onChange={() => save({ voice_mode: 'open' })} />
        Microfone aberto <small className="muted">(com a sensibilidade de cima)</small>
      </label>
      <label className="check">
        <input type="radio" checked={ptt} onChange={() => save({ voice_mode: 'ptt' })} />
        Apertar para falar <small className="muted">(o microfone só abre segurando a tecla)</small>
      </label>
      {ptt && (
        <ShortcutField label="Tecla de falar" value={hotkeyOf(settings, 'ptt')} allowBare onChange={(v) => save({ hotkey_ptt: v })} />
      )}
      <ShortcutField label="Silenciar / ativar microfone" value={hotkeyOf(settings, 'mute')} onChange={(v) => save({ hotkey_mute: v })} />
      <ShortcutField label="Ensurdecer" value={hotkeyOf(settings, 'deafen')} onChange={(v) => save({ hotkey_deafen: v })} />
      <ShortcutField label="Salvar clipe" value={hotkeyOf(settings, 'clip')} onChange={(v) => save({ hotkey_clip: v })} />
      <p className="muted small">
        {kind === 'kde'
          ? 'Os atalhos funcionam mesmo com um jogo em foco (registrados no KDE como "Discord Local", só enquanto você está numa call).'
          : 'Silenciar e ensurdecer funcionam mesmo com um jogo em foco (só enquanto você está numa call). Apertar para falar funciona com o app em foco.'}
        {ptt && !hotkeyOf(settings, 'ptt') && ' Escolha a tecla de falar.'}
      </p>
    </>
  );
}

/** Campo que grava uma combinação de teclas ao clicar. */
function ShortcutField({ label, value, onChange, allowBare }: { label: string; value: string; onChange: (v: string) => void; allowBare?: boolean }) {
  const [recording, setRecording] = useState(false);
  return (
    <label className="shortcut-field">
      <span>{label}</span>
      <button
        type="button"
        className={recording ? 'recording' : ''}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') return setRecording(false);
          if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            onChange('');
            return setRecording(false);
          }
          const a = accelFromEvent(e);
          if (!a) return; // só modificador por enquanto
          const bare = !a.includes('+');
          // Atalho de alternar sem modificador roubaria a tecla de todo mundo; no "falar" pode (ex.: F13, `).
          if (bare && !allowBare && !/^F\d+$/.test(a)) return;
          onChange(a);
          setRecording(false);
        }}
      >
        {recording ? 'aperte a combinação… (Esc cancela, ⌫ apaga)' : prettyAccel(value)}
      </button>
    </label>
  );
}
