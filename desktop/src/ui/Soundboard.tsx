import { useRef, useState } from 'react';
import { app, useApp } from '../app.ts';
import { previewSound, uploadSound } from '../sounds.ts';

const fail = (e: unknown) => app.toast((e as Error).message);
const EMOJIS = ['🔊', '😂', '👏', '📯', '🥁', '💥', '🐐', '💀', '🤡', '🎺', '🔔', '😱'];

/** Botões de som que tocam pra todo mundo na call. */
export function SoundboardPanel({ onClose }: { onClose: () => void }) {
  const sounds = useApp((s) => s.sounds);
  const admin = useApp((s) => s.admin);
  const meId = useApp((s) => s.profile?.user.id);
  const volume = useApp((s) => s.profile?.settings?.sound_volume ?? 60);
  const [adding, setAdding] = useState(false);

  return (
    <div className="bot-panel soundboard">
      <div className="bot-panel-head">
        <strong>📢 Soundboard</strong>
        <small className="muted">clique para tocar pra todos na call</small>
        <input
          className="bot-volume"
          type="range"
          min={0}
          max={100}
          value={volume}
          title={`Volume dos sons pra você: ${volume}%`}
          onChange={(e) => app.saveSettings({ sound_volume: Number(e.target.value) })}
        />
        <button className="icon" title="Fechar" onClick={onClose}>✕</button>
      </div>
      <div className="sound-grid">
        {sounds.map((snd) => (
          <div key={snd.id} className="sound-btn-wrap">
            <button
              className="sound-btn"
              title={`Tocar "${snd.name}" pra todos (botão direito: só pra mim)`}
              onClick={() => app.playSoundForAll(snd.id).catch(fail)}
              onContextMenu={(e) => {
                e.preventDefault();
                previewSound(snd.id).catch(fail);
              }}
            >
              <span className="sound-emoji">{snd.emoji}</span>
              <span className="sound-name">{snd.name}</span>
            </button>
            {(snd.uploader_id === meId || admin) && (
              <button className="sound-del" title="Apagar som" onClick={() => app.deleteSound(snd.id).catch(fail)}>
                ✕
              </button>
            )}
          </div>
        ))}
        <button className="sound-btn add" onClick={() => setAdding(true)} title="Adicionar um som (até 1 MB)">
          <span className="sound-emoji">➕</span>
          <span className="sound-name">adicionar</span>
        </button>
      </div>
      {!sounds.length && <small className="muted">Nenhum som ainda. Adicione um áudio curto (mp3, ogg, wav… até 1 MB).</small>}
      {adding && <AddSound onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddSound({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🔊');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function save() {
    if (!file || !name.trim()) return;
    setBusy(true);
    try {
      await uploadSound(file, name.trim(), emoji);
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="add-sound"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        ref={input}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setFile(f);
          if (f && !name) setName(f.name.replace(/\.[^.]+$/, '').slice(0, 40));
        }}
      />
      <button type="button" onClick={() => input.current?.click()}>{file ? `🎵 ${file.name}` : 'Escolher áudio…'}</button>
      <input value={name} maxLength={40} placeholder="Nome do som" onChange={(e) => setName(e.target.value)} />
      <div className="status-emojis">
        {EMOJIS.map((e) => (
          <button type="button" key={e} className={emoji === e ? 'on' : ''} onClick={() => setEmoji(e)}>
            {e}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>Cancelar</button>
        <button type="submit" className="primary" disabled={busy || !file || !name.trim()}>
          {busy ? 'Enviando…' : 'Adicionar'}
        </button>
      </div>
    </form>
  );
}
