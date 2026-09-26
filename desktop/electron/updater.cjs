// Atualizações pelas Releases do GitHub (electron-updater).
// Funciona no instalador do Windows (NSIS) e no AppImage; rodando pelo código-fonte, fica desativado.

const { app } = require('electron');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15_000;

let status = { state: 'idle', current: app.getVersion() };
let send = () => {};
let updater = null;

function supported() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return true;
  return process.platform === 'linux' && !!process.env.APPIMAGE;
}

function setStatus(patch) {
  status = { ...status, ...patch, current: app.getVersion() };
  send(status);
}

function notesText(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes.replace(/<[^>]+>/g, '').trim();
  return notes.map((n) => n.note ?? '').join('\n').replace(/<[^>]+>/g, '').trim();
}

function init(onStatus) {
  send = onStatus;
  if (!supported()) {
    status = { state: 'unsupported', current: app.getVersion() };
    return;
  }
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = false; // o usuário decide quando baixar
  updater.autoInstallOnAppQuit = true; // baixou e não reiniciou: instala ao fechar
  updater.on('checking-for-update', () => setStatus({ state: 'checking', message: undefined }));
  updater.on('update-not-available', () => setStatus({ state: 'none', checked_at: Date.now() }));
  updater.on('update-available', (i) =>
    setStatus({ state: 'available', version: i.version, notes: notesText(i.releaseNotes), checked_at: Date.now() }),
  );
  updater.on('download-progress', (p) => setStatus({ state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => setStatus({ state: 'ready', version: i.version }));
  updater.on('error', (e) => setStatus({ state: 'error', message: String(e?.message ?? e).split('\n')[0] }));

  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}

function check() {
  // Não interrompe um download em andamento nem esconde um "pronto para instalar".
  if (!updater || ['downloading', 'ready'].includes(status.state)) return status;
  updater.checkForUpdates().catch(() => {}); // erro chega pelo evento 'error'
  return status;
}

function download() {
  if (!updater || status.state !== 'available') return;
  setStatus({ state: 'downloading', percent: 0 });
  updater.downloadUpdate().catch(() => {});
}

/** Fecha o app e roda o instalador novo (que reabre o app atualizado). */
function install() {
  if (!updater || status.state !== 'ready') return;
  updater.quitAndInstall(true, true);
}

module.exports = { init, check, download, install, getStatus: () => status };
