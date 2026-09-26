import { useApp } from '../app.ts';

/** Aviso compacto na lateral quando há versão nova (some quando não há nada a fazer). */
export function UpdateBanner() {
  const u = useApp((s) => s.update);
  if (u.state === 'available') {
    return (
      <div className="update-banner">
        <span>Nova versão <strong>{u.version}</strong></span>
        <button className="mini green" onClick={() => window.native.updateDownload()}>Atualizar</button>
      </div>
    );
  }
  if (u.state === 'downloading') {
    return (
      <div className="update-banner">
        <span>Baixando {u.version ?? 'atualização'}… {u.percent ?? 0}%</span>
        <div className="progress"><div style={{ width: `${u.percent ?? 0}%` }} /></div>
      </div>
    );
  }
  if (u.state === 'ready') {
    return (
      <div className="update-banner">
        <span>{u.version} pronta</span>
        <button className="mini green" onClick={() => window.native.updateInstall()}>Reiniciar e atualizar</button>
      </div>
    );
  }
  return null;
}

/** Seção de Configurações. */
export function UpdateSection() {
  const u = useApp((s) => s.update);
  const inCall = useApp((s) => !!s.call);
  const text: Record<typeof u.state, string> = {
    idle: '',
    unsupported: 'Atualização automática indisponível nesta cópia (rodando pelo código-fonte).',
    checking: 'Verificando…',
    none: 'Você está na versão mais recente.',
    available: `Versão ${u.version} disponível.`,
    downloading: `Baixando ${u.version ?? ''}… ${u.percent ?? 0}%`,
    ready: `Versão ${u.version} baixada. Reinicie para instalar.`,
    error: `Não consegui verificar: ${u.message ?? 'erro'}`,
  };
  return (
    <>
      <h4>Atualizações</h4>
      <p className="small">
        Versão instalada: <code>{u.current || '?'}</code>
      </p>
      {text[u.state] && <p className={`small ${u.state === 'error' ? 'err-text' : 'muted'}`}>{text[u.state]}</p>}
      {u.state === 'available' && u.notes && <pre className="notes">{u.notes}</pre>}
      {u.state === 'downloading' && <div className="progress"><div style={{ width: `${u.percent ?? 0}%` }} /></div>}
      <div className="export-row">
        {u.state === 'available' ? (
          <button className="primary" onClick={() => window.native.updateDownload()}>Baixar e instalar</button>
        ) : u.state === 'ready' ? (
          <button className="primary" onClick={() => window.native.updateInstall()}>
            Reiniciar e atualizar{inCall ? ' (sai da call)' : ''}
          </button>
        ) : (
          <button disabled={['unsupported', 'checking', 'downloading'].includes(u.state)} onClick={() => window.native.updateCheck()}>
            Verificar agora
          </button>
        )}
      </div>
    </>
  );
}
