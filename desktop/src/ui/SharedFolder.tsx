import { useEffect, useState } from 'react';
import type { ShareEntry } from '../../../shared/protocol.ts';
import { app } from '../app.ts';
import { formatSize } from '../files.ts';
import { ask, fetchShared } from '../share.ts';

type Job = { key: string; name: string; state: 'pedindo' | 'enviando' | 'baixando' | 'pronto' | 'erro'; done: number; total: number; path?: string; error?: string };

/** Navegar na pasta compartilhada de alguém. */
export function SharedFolder({ userId, onClose }: { userId: string; onClose: () => void }) {
  const name = app.user(userId)?.display_name ?? '?';
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<ShareEntry[] | null>(null);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    setEntries(null);
    setError('');
    ask(userId, { type: 'list', path }).then((r) => {
      if (r.ok && r.type === 'list') setEntries(r.entries);
      else setError(r.ok ? 'resposta inesperada' : r.error);
    }, (e) => setError((e as Error).message));
  }, [path]);

  useEffect(
    () =>
      window.native.onShareProgress?.(({ key, done, total }) =>
        setJobs((js) => js.map((j) => (j.key === key ? { ...j, state: 'baixando', done, total } : j))),
      ),
    [],
  );

  const update = (key: string, patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  async function get(e: ShareEntry) {
    const key = Math.random().toString(36).slice(2);
    const rel = path ? `${path}/${e.name}` : e.name;
    setJobs((js) => [...js, { key, name: e.name, state: 'pedindo', done: 0, total: e.size }]);
    update(key, { state: 'enviando' });
    const r = await ask(userId, { type: 'get', path: rel }).catch((err) => ({ ok: false as const, error: (err as Error).message }));
    if (!r.ok || r.type !== 'get') return update(key, { state: 'erro', error: r.ok ? 'resposta inesperada' : r.error });
    try {
      const saved = await fetchShared(key, r.url, r.name);
      update(key, { state: 'pronto', path: saved ?? undefined, done: r.size, total: r.size });
    } catch (err) {
      update(key, { state: 'erro', error: (err as Error).message });
    }
  }

  const crumbs = path ? path.split('/') : [];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-modal" onClick={(e) => e.stopPropagation()}>
        <h3>📁 Pasta de {name}</h3>
        <div className="crumbs">
          <button className="link" onClick={() => setPath('')}>início</button>
          {crumbs.map((c, i) => (
            <span key={i}>
              {' / '}
              <button className="link" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
            </span>
          ))}
        </div>
        <div className="folder-list">
          {error && <div className="error">{error}</div>}
          {!entries && !error && <small className="muted">Pedindo a lista ao PC de {name}…</small>}
          {entries && !entries.length && <small className="muted">Pasta vazia.</small>}
          {path && entries && (
            <button className="folder-row" onClick={() => setPath(crumbs.slice(0, -1).join('/'))}>
              <span>⬆</span>
              <span className="folder-name">..</span>
            </button>
          )}
          {entries?.map((e) => (
            <button key={e.name} className="folder-row" onClick={() => (e.dir ? setPath(path ? `${path}/${e.name}` : e.name) : get(e))} title={e.dir ? 'Abrir pasta' : 'Baixar'}>
              <span>{e.dir ? '📁' : '📄'}</span>
              <span className="folder-name">{e.name}</span>
              <small className="muted">{e.dir ? '' : formatSize(e.size)}</small>
              <small className="muted">{new Date(e.mtime).toLocaleDateString('pt-BR')}</small>
              {!e.dir && <span className="folder-dl">⬇</span>}
            </button>
          ))}
        </div>
        {jobs.length > 0 && (
          <div className="folder-jobs">
            {jobs.map((j) => (
              <div key={j.key} className="upload">
                <span>{j.name}</span>
                {j.state === 'baixando' || j.state === 'pronto' ? (
                  <div className="file-progress">
                    <span style={{ width: `${(j.done / Math.max(1, j.total)) * 100}%` }} />
                  </div>
                ) : (
                  <small className="muted">{j.state === 'enviando' ? `o PC de ${name} está enviando…` : j.state === 'erro' ? j.error : j.state}</small>
                )}
                {j.state === 'pronto' && j.path && (
                  <button className="mini" onClick={() => window.native.shareShow?.(j.path!)}>mostrar</button>
                )}
              </div>
            ))}
          </div>
        )}
        <small className="muted">Arquivos vão para Downloads/Discord Local. O PC de {name} precisa estar com o app aberto.</small>
        <div className="modal-actions">
          <button onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );
}
