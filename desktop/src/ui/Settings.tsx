import { useEffect, useState } from 'react';
import { app, errorMessage, useApp } from '../app.ts';
import { UpdateSection } from './Update.tsx';
import type { NetInterface } from '../native.d.ts';

export function Settings({ onClose }: { onClose: () => void }) {
  const profile = useApp((s) => s.profile)!;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    // Os nomes dos dispositivos só aparecem depois da permissão de microfone.
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((st) => st.getTracks().forEach((t) => t.stop()))
      .catch(() => {})
      .finally(() => navigator.mediaDevices.enumerateDevices().then(setDevices));
  }, []);

  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const outputs = devices.filter((d) => d.kind === 'audiooutput');

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
        <p className="muted small">Mudanças de dispositivo valem a partir da próxima call.</p>
        <hr />
        {profile.role === 'host' ? <HostSection /> : (
          <p className="small">
            Host: <code>{profile.server_url}</code>
          </p>
        )}
        <hr />
        <UpdateSection />
        <hr />
        <p className="small muted">Seu histórico fica salvo neste computador, na pasta de dados do app.</p>
        <div className="modal-actions">
          <button onClick={() => window.native.openDataDir()}>Abrir pasta de dados</button>
          <button className="danger" onClick={() => { onClose(); app.logout(); }}>Sair da conta</button>
          <button className="primary" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
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
