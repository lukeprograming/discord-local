import { useEffect, useState } from 'react';
import { app, useApp } from '../app.ts';
import type { CallDiagnostics } from '../rtc.ts';

/** 🩺 Diagnóstico da call: microfone, caminhos de conexão e áudio indo/chegando de cada pessoa. */
export function DiagnosticsPanel({ onClose }: { onClose?: () => void }) {
  const call = useApp((s) => s.call);
  const [d, setD] = useState<CallDiagnostics | null>(null);
  useEffect(() => {
    if (!call) return;
    let alive = true;
    const tick = () => call.diagnostics().then((x) => alive && setD(x)).catch(() => {});
    tick();
    const t = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [call]);

  const name = (id: string) => app.user(id)?.display_name ?? '?';
  const text = d ? toText(d, name) : '';

  return (
    <div className="bot-panel diag-panel">
      <div className="bot-panel-head">
        <strong>🩺 Diagnóstico da call</strong>
        <small className="muted">atualiza sozinho</small>
        <button className="mini" onClick={() => navigator.clipboard?.writeText(text).then(() => app.toast('Diagnóstico copiado'))}>copiar</button>
        <button
          className="mini"
          title="Manda o texto no chat desta call (pra quem estiver ajudando ver)"
          onClick={() => call && app.send(call.conversationId, '🩺 Diagnóstico (' + (app.me()?.display_name ?? '') + ', ' + app.state.platform + ')\n' + text.slice(0, 3900))}
        >
          mandar no chat
        </button>
        {onClose && <button className="icon" title="Fechar" onClick={onClose}>✕</button>}
      </div>
      {!d ? (
        <small className="muted">Medindo…</small>
      ) : (
        <>
          <section className="diag-block">
            <strong>🎤 Meu microfone</strong>
            <div className={`diag-line ${d.mic.found ? 'ok' : 'bad'}`}>
              {d.mic.found ? `encontrado: ${d.mic.label || 'sem nome'} (${d.mic.state})` : 'SEM MICROFONE — entrou só ouvindo'}
            </div>
            <div className={`diag-line ${d.mic.muted ? 'warn' : 'ok'}`}>{d.mic.muted ? 'mutado' : 'aberto'}{d.mic.deafened ? ' · ensurdecido' : ''}</div>
            <div className="diag-line">
              nível agora: {d.mic.level === null ? '—' : `${d.mic.level} dB`} · tratamento: {d.mic.processing} · áudio do app: {d.mic.context}
            </div>
            {d.mic.localIps.length > 0 && <div className="diag-line">IPs deste aparelho: {d.mic.localIps.join(', ')}</div>}
          </section>
          {d.peers.length === 0 && <small className="muted">Ninguém mais na call.</small>}
          {d.peers.map((p) => (
            <section key={p.userId} className="diag-block">
              <strong>👤 {name(p.userId)}</strong>
              <div className={`diag-line ${p.connection === 'connected' ? 'ok' : p.connection === 'failed' ? 'bad' : 'warn'}`}>
                conexão: {p.connection} · ice: {p.ice} · coleta: {p.gathering}
              </div>
              <div className="diag-line">caminho: {p.pair}</div>
              <div className={`diag-line ${p.outKbps ? 'ok' : 'warn'}`}>meu áudio saindo pra ele(a): {p.outKbps ?? '…'} kbps</div>
              <div className={`diag-line ${p.inKbps ? 'ok' : 'warn'}`}>
                áudio dele(a) chegando: {p.inKbps ?? '…'} kbps · volume {p.inLevel}%
              </div>
              <details>
                <summary>endereços ({p.local.length} meus, {p.remote.length} dele(a))</summary>
                <div className="diag-mono">meus: {p.local.join(' | ') || '—'}</div>
                <div className="diag-mono">dele(a): {p.remote.join(' | ') || '—'}</div>
              </details>
            </section>
          ))}
          <details>
            <summary>log da conexão</summary>
            <pre className="diag-mono">{d.log.join('\n')}</pre>
          </details>
        </>
      )}
    </div>
  );
}

function toText(d: CallDiagnostics, name: (id: string) => string): string {
  const m = d.mic;
  const lines = [
    `mic: ${m.found ? m.label || 'ok' : 'SEM MIC'} ${m.state} ${m.muted ? 'mutado' : 'aberto'} nivel=${m.level ?? '-'}dB trat=${m.processing} ctx=${m.context} ips=${m.localIps.join(',') || '-'}`,
    ...d.peers.flatMap((p) => [
      `${name(p.userId)}: conn=${p.connection} ice=${p.ice} coleta=${p.gathering} sai=${p.outKbps ?? '-'}kbps chega=${p.inKbps ?? '-'}kbps vol=${p.inLevel}%`,
      `  caminho: ${p.pair}`,
      `  meus: ${p.local.join(' | ') || '-'}`,
      `  dele: ${p.remote.join(' | ') || '-'}`,
    ]),
  ];
  return lines.join('\n');
}
