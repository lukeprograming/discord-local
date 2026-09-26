import { useEffect, useState } from 'react';
import { app, errorMessage, useApp } from '../app.ts';
import { checkServer } from '../gateway.ts';
import type { NetInterface } from '../native.d.ts';

type Mode = 'login' | 'register';

export function Setup() {
  const profile = useApp((s) => s.profile);
  const embedded = useApp((s) => s.embedded);
  const [path, setPath] = useState<'choose' | 'host' | 'client'>(
    profile?.role === 'host' ? 'host' : profile || embedded ? 'client' : 'choose',
  );

  return (
    <div className="setup">
      <div className="setup-card">
        <h1>Discord Local</h1>
        {path === 'choose' && (
          <>
            <p className="muted">Chat, call e tela entre amigos, pela sua VPN (Tailscale, ZeroTier, Hamachi…).</p>
            <div className="choice">
              <button onClick={() => setPath('host')}>
                <strong>🖥 Ser o host</strong>
                <span className="muted">O servidor fica neste computador. Você convida os amigos exportando um instalador.</span>
              </button>
              <button onClick={() => setPath('client')}>
                <strong>🔌 Conectar em um host</strong>
                <span className="muted">Um amigo já é o host e te passou o endereço e um código de convite.</span>
              </button>
            </div>
          </>
        )}
        {path === 'host' && <HostSetup onBack={profile ? undefined : () => setPath('choose')} />}
        {path === 'client' && <ClientSetup onBack={profile || embedded ? undefined : () => setPath('choose')} />}
      </div>
    </div>
  );
}

function AccountFields({ mode, form, setForm }: { mode: Mode; form: Record<string, string>; setForm: (f: Record<string, string>) => void }) {
  const field = (k: string) => ({
    value: form[k] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }),
  });
  return (
    <>
      <label>
        Usuário
        <input {...field('username')} autoComplete="username" required />
      </label>
      {mode === 'register' && (
        <label>
          Nome de exibição
          <input {...field('display_name')} placeholder="opcional" />
        </label>
      )}
      <label>
        Senha
        <input {...field('password')} type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
      </label>
    </>
  );
}

function HostSetup({ onBack }: { onBack?: () => void }) {
  const profile = useApp((s) => s.profile);
  const busy = useApp((s) => s.hostBusy);
  const saved = profile?.host;
  const [ifaces, setIfaces] = useState<NetInterface[]>([]);
  const [ip, setIp] = useState(saved?.ip ?? '');
  const [port, setPort] = useState(String(saved?.port ?? 47200));
  const [name, setName] = useState(saved?.name ?? '');
  const [tailscale, setTailscale] = useState(saved?.tailscale ?? true);
  const [form, setForm] = useState<Record<string, string>>({ username: profile?.user.username ?? '' });
  const [error, setError] = useState('');
  const relogin = !!saved; // host já configurado, só saiu da conta

  useEffect(() => {
    window.native.interfaces().then((list) => {
      setIfaces(list);
      if (!ip && list[0]) {
        setIp(list[0].ip);
        setTailscale(list[0].vpn === 'Tailscale');
      }
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const displayName = form.display_name?.trim() || form.username;
      await app.setupHost(
        { ip, port: Number(port), name: name.trim() || `Servidor de ${displayName}`, tailscale },
        form,
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit}>
      <p className="muted">
        {relogin ? 'Entre de novo na sua conta de host.' : 'O servidor vai rodar neste computador, no IP da sua VPN.'}
      </p>
      {!relogin && (
        <>
          <label>
            Nome do servidor
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex: Servidor do Lucas" maxLength={40} />
          </label>
          <label>IP da VPN deste computador</label>
          <div className="iface-list">
            {ifaces.map((i) => (
              <label key={i.ip} className="check">
                <input
                  type="radio"
                  checked={ip === i.ip}
                  onChange={() => {
                    setIp(i.ip);
                    setTailscale(i.vpn === 'Tailscale');
                  }}
                />
                <span>
                  <strong>{i.vpn}</strong> <code>{i.ip}</code> <small className="muted">{i.name}</small>
                </span>
              </label>
            ))}
            <label className="check">
              <input type="radio" checked={!ifaces.some((i) => i.ip === ip)} onChange={() => setIp('')} />
              <span>Outro:</span>
              <input className="inline" value={ifaces.some((i) => i.ip === ip) ? '' : ip} onChange={(e) => setIp(e.target.value.trim())} placeholder="IP" />
            </label>
          </div>
          <div className="row">
            <label>
              Porta
              <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
            </label>
            <label className="check grow">
              <input type="checkbox" checked={tailscale} onChange={(e) => setTailscale(e.target.checked)} />
              Ligar o Tailscale ao iniciar a sessão
            </label>
          </div>
          <p className="muted small">Não vê sua VPN? Ligue-a e reabra esta tela. Hamachi/ZeroTier você liga pelo próprio programa deles.</p>
          <h4>Sua conta</h4>
        </>
      )}
      <AccountFields mode={relogin ? 'login' : 'register'} form={form} setForm={setForm} />
      {!relogin && <p className="muted small">Se este servidor já tinha uma conta, use o mesmo usuário e senha para entrar.</p>}
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy || !ip || !port}>
        {busy ? 'Iniciando servidor…' : relogin ? 'Iniciar e entrar' : 'Criar servidor'}
      </button>
      {onBack && <button type="button" className="link back" onClick={onBack}>← voltar</button>}
    </form>
  );
}

function ClientSetup({ onBack }: { onBack?: () => void }) {
  const profile = useApp((s) => s.profile);
  const embedded = useApp((s) => s.embedded);
  const [server, setServer] = useState(profile?.server_url ?? embedded?.server_url ?? '');
  const [mode, setMode] = useState<Mode>(profile ? 'login' : 'register');
  const [serverName, setServerName] = useState<string | null>(null);
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [form, setForm] = useState<Record<string, string>>({ username: profile?.user.username ?? '', invite_code: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editServer, setEditServer] = useState(!embedded);

  // Procura o host enquanto o endereço é digitado, e de novo a cada 5s se não achar.
  useEffect(() => {
    if (!server.trim()) return setServerOk(null);
    let alive = true;
    let timer = 0;
    const probe = () =>
      checkServer(server)
        .then((h) => {
          if (!alive) return;
          setServerOk(true);
          setServerName((h as { server_name?: string }).server_name ?? null);
        })
        .catch(() => {
          if (!alive) return;
          setServerOk(false);
          timer = window.setTimeout(probe, 5000);
        });
    setServerOk(null);
    timer = window.setTimeout(probe, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [server]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body = { ...form };
      if (mode === 'register' && embedded && !editServer) body.invite_code = embedded.invite_code;
      await app.authenticate(server, mode, body);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hostLabel = serverName ?? embedded?.host_name ?? 'host';

  return (
    <form onSubmit={submit}>
      {embedded && !editServer ? (
        <>
          <p>
            Entrar em <strong>{embedded.host_name}</strong>
          </p>
          <div className="server-fixed">
            <code>{server}</code>
            <button type="button" className="link" onClick={() => setEditServer(true)}>trocar</button>
          </div>
        </>
      ) : (
        <label>
          Endereço do host
          <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://100.x.x.x:47200" />
        </label>
      )}
      <div className={`server-status ${serverOk === false ? 'bad' : serverOk ? 'good' : ''}`}>
        {serverOk === null && server && 'procurando o host…'}
        {serverOk === true && `● ${hostLabel} está online`}
        {serverOk === false && `● ${hostLabel} não encontrado — o host precisa iniciar a sessão, e sua VPN precisa estar ligada. Tentando de novo…`}
      </div>

      <div className="tabs">
        <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
          Criar conta
        </button>
        <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
          Já tenho conta
        </button>
      </div>

      <AccountFields mode={mode} form={form} setForm={setForm} />
      {mode === 'register' && (!embedded || editServer) && (
        <label>
          Código de convite
          <input
            value={form.invite_code}
            onChange={(e) => setForm({ ...form, invite_code: e.target.value })}
            placeholder="peça para o host"
            required
          />
        </label>
      )}

      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy || !serverOk}>
        {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
      </button>
      {onBack && <button type="button" className="link back" onClick={onBack}>← voltar</button>}
    </form>
  );
}
