import { useEffect, useState } from 'react';
import { Download, File, FileArchive, FileAudio, FileImage, FileText, FileVideo, Upload, X } from 'lucide-react';
import type { FileAttachment } from '../../../shared/protocol.ts';
import { app } from '../app.ts';
import { ANDROID_IN_APP_MAX, download, formatSize, inApp, preview, useFile, useUploads } from '../files.ts';

function Icon({ att }: { att: FileAttachment }) {
  const m = att.mime;
  const C = m.startsWith('image/')
    ? FileImage
    : m.startsWith('video/')
      ? FileVideo
      : m.startsWith('audio/')
        ? FileAudio
        : /zip|rar|7z|tar|gzip|compressed/.test(m)
          ? FileArchive
          : m === 'application/pdf' || m.startsWith('text/')
            ? FileText
            : File;
  return <C size={22} />;
}

/** "ZIP", "PDF"… a partir do nome. */
function ext(name: string): string {
  const e = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  return e ? e.toUpperCase() : 'arquivo';
}

const fail = (e: unknown) => app.toast((e as Error).message);

/** Arquivo numa mensagem: prévia de imagem, progresso do download e abrir/salvar. */
export function FileCard({ conversationId, attachment: att }: { conversationId: string; attachment: FileAttachment }) {
  const st = useFile(conversationId, att);
  const android = app.state.platform === 'android';
  const [img, setImg] = useState<string | null>(null);
  const isImage = att.mime.startsWith('image/') && att.size <= ANDROID_IN_APP_MAX;

  useEffect(() => {
    if (st.status === 'local' && isImage) preview(st.path, att).then(setImg).catch(() => setImg(null));
  }, [st.status === 'local' ? st.path : null]);

  const open = () => st.status === 'local' && window.native.fileOpen?.(st.path).catch(fail);

  return (
    <div className="file-card">
      {img && <img className="file-img" src={img} alt={att.name} onClick={android ? undefined : open} title={android ? undefined : 'Abrir'} />}
      <div className="file-row">
        <span className="file-icon"><Icon att={att} /></span>
        <div className="file-info">
          <span className="file-name" title={att.name}>
            {att.name}
          </span>
          <small className="muted">
            {formatSize(att.size)} · {ext(att.name)}
            {st.status === 'downloading' && ` — baixando ${Math.floor((st.done / Math.max(1, st.total)) * 100)}%`}
            {st.status === 'error' && ` — ${st.error}`}
          </small>
          {st.status === 'downloading' && (
            <div className="file-progress">
              <span style={{ width: `${(st.done / Math.max(1, st.total)) * 100}%` }} />
            </div>
          )}
        </div>
        <div className="file-actions">
          {st.status === 'local' && !android && (
            <>
              <button className="mini" onClick={open}>abrir</button>
              <button className="mini" onClick={() => window.native.fileShow?.(st.path)}>pasta</button>
              <button className="mini" onClick={() => window.native.fileSaveAs?.(st.path).catch(fail)}>salvar como</button>
            </>
          )}
          {(st.status === 'remote' || st.status === 'error') && (
            <button className="mini file-dl" title={inApp(att) ? 'Baixar' : 'Baixar pelo navegador'} onClick={() => download(conversationId, att).catch(fail)}>
              <Download size={15} /> {inApp(att) ? 'baixar' : 'baixar pelo navegador'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Uploads em andamento desta conversa (acima da caixa de texto). */
export function UploadList({ conversationId }: { conversationId: string }) {
  const list = useUploads(conversationId);
  if (!list.length) return null;
  return (
    <div className="uploads">
      {list.map((u) => (
        <div key={u.key} className="upload">
          <span><Upload size={13} /> {u.name}</span>
          <div className="file-progress">
            <span style={{ width: `${(u.done / Math.max(1, u.total)) * 100}%` }} />
          </div>
          <small className="muted">{Math.floor((u.done / Math.max(1, u.total)) * 100)}%</small>
          <button className="icon" title="Cancelar" aria-label="Cancelar envio" onClick={u.cancel}><X size={16} /></button>
        </div>
      ))}
    </div>
  );
}
