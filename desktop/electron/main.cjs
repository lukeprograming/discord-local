const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('./store.cjs');
const host = require('./host.cjs');
const embed = require('./embed.cjs');
const updater = require('./updater.cjs');

// Releases de onde vêm as atualizações e os instaladores limpos para exportar.
const GITHUB_REPO = 'lukeprograming/discord-local';

// --profile=nome separa os dados: permite abrir duas contas na mesma máquina para testar.
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1].replace(/[^a-zA-Z0-9_-]/g, '') : '';
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `discord-local-${profile}`));

// Sem isso o Chromium esconde o IP local atrás de um nome .local (mDNS),
// que não resolve pela VPN, e o WebRTC não conecta.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Captura de tela no Wayland via xdg-desktop-portal + PipeWire.
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

let win = null;
let store = null;
let pendingPick = null; // callback do setDisplayMediaRequestHandler aguardando o seletor
let quitting = false; // saída já em andamento (não segurar no before-quit)

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#1e1f22',
    title: profile ? `Discord Local (${profile})` : 'Discord Local',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // calls continuam fluindo com a janela minimizada
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Links clicados no chat abrem no navegador, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => (win = null));
}

function setupMedia() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'notifications', 'display-capture', 'speaker-selection'].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'notifications', 'display-capture', 'speaker-selection'].includes(permission),
  );

  // getDisplayMedia() no renderer cai aqui.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    });
    // Áudio do sistema: o Chromium só implementa loopback no Windows.
    const audio = request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined;
    const finish = (source) => (source ? callback({ video: source, audio }) : callback({}));

    // No Wayland o portal já mostrou o seletor nativo e devolve só o escolhido.
    if (sources.length <= 1) return finish(sources[0]);

    if (pendingPick) pendingPick(null);
    pendingPick = (id) => {
      pendingPick = null;
      finish(sources.find((s) => s.id === id));
    };
    win?.webContents.send('screen:choose', sources.map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      isScreen: s.id.startsWith('screen:'),
    })));
  });
}

function setupIpc() {
  ipcMain.handle('store:loadProfile', () => store.loadProfile());
  ipcMain.handle('store:saveProfile', (_e, p) => store.saveProfile(p));
  ipcMain.handle('store:loadMessages', (_e, convId) => store.loadMessages(convId));
  ipcMain.handle('store:appendMessages', (_e, convId, msgs) => store.appendMessages(convId, msgs));
  ipcMain.handle('store:loadOutbox', () => store.loadOutbox());
  ipcMain.handle('store:saveOutbox', (_e, list) => store.saveOutbox(list));
  ipcMain.handle('store:dataDir', () => store.dir);
  ipcMain.handle('store:openDataDir', () => shell.openPath(store.dir));
  ipcMain.handle('screen:picked', (_e, id) => pendingPick?.(id));
  ipcMain.handle('app:info', () => ({ platform: process.platform, profile, version: app.getVersion() }));
  ipcMain.handle('app:flash', () => {
    if (win && !win.isFocused()) win.flashFrame(true);
  });

  // ---- host / conectado ----
  ipcMain.handle('net:interfaces', () => host.listInterfaces());
  ipcMain.handle('host:start', (_e, cfg) => host.startHost(cfg, path.join(app.getPath('userData'), 'servidor')));
  ipcMain.handle('host:stop', () => host.stopHost());
  ipcMain.handle('host:status', () => host.status());
  ipcMain.handle('embed:read', () => embed.readEmbedded());
  ipcMain.handle('host:export', (_e, platform, cfg, pickAgain) => exportConnector(platform, cfg, pickAgain));

  // ---- atualizações ----
  ipcMain.handle('update:get', () => updater.getStatus());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.handle('update:install', async () => {
    // Desliga o servidor embutido antes: o instalador precisa do app fechado.
    quitting = true;
    await host.stopHost().catch(() => {});
    updater.install();
  });
}

const INSTALLERS = {
  win32: { ext: '.exe', label: 'Windows', example: 'Discord-Local-x.y.z-win.exe', pattern: /^Discord-Local-[\d.]+-win\.exe$/i },
  linux: { ext: '.AppImage', label: 'Linux', example: 'Discord-Local-x.y.z-linux.AppImage', pattern: /^Discord-Local-[\d.]+-linux\.AppImage$/i },
};

function readInstallerCache() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'instaladores.json'), 'utf8'));
  } catch {
    return {};
  }
}

function saveInstallerCache(cache) {
  fs.writeFileSync(path.join(app.getPath('userData'), 'instaladores.json'), JSON.stringify(cache, null, 2));
}

/** Procura o instalador limpo da plataforma sem perguntar nada ao usuário. */
function findCleanInstaller(platform) {
  const { pattern } = INSTALLERS[platform];
  if (platform === 'linux' && process.env.APPIMAGE) return process.env.APPIMAGE;
  const cached = readInstallerCache()[platform];
  if (cached && fs.existsSync(cached)) return cached;

  const dirs = new Set([
    app.getPath('downloads'),
    app.getPath('desktop'),
    path.dirname(process.execPath),
    process.env.APPIMAGE ? path.dirname(process.env.APPIMAGE) : null,
    path.join(__dirname, '..', 'release'), // rodando pelo código-fonte
  ].filter(Boolean));
  let best = null;
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (!embed.isStamped(file) && (!best || mtimeMs > best.mtimeMs)) best = { file, mtimeMs };
      } catch {
        /* ilegível */
      }
    }
  }
  return best?.file ?? null;
}

/**
 * Baixa o instalador limpo da plataforma nas Releases do GitHub (preferindo a
 * mesma versão deste app) para a pasta de dados. Retorna null se não conseguir.
 */
async function downloadCleanInstaller(platform) {
  const { pattern } = INSTALLERS[platform];
  try {
    const headers = { 'user-agent': 'discord-local', accept: 'application/vnd.github+json' };
    const tag = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${app.getVersion()}`, { headers });
    const res = tag.ok ? tag : await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers });
    if (!res.ok) return null;
    const release = await res.json();
    const asset = release.assets?.find((a) => pattern.test(a.name));
    if (!asset) return null;

    const dir = path.join(app.getPath('userData'), 'instaladores');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, asset.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size === asset.size) return dest;

    win?.webContents.send('export:progress', { downloading: asset.name, size: asset.size });
    const bin = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'discord-local' } });
    if (!bin.ok) return null;
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, Buffer.from(await bin.arrayBuffer()));
    if (fs.statSync(tmp).size !== asset.size) return null;
    fs.renameSync(tmp, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Gera o instalador dos conectados: pega o instalador limpo da plataforma
 * e salva uma cópia carimbada com a config do host onde o usuário escolher.
 */
async function exportConnector(platform, cfg, pickAgain) {
  const info = INSTALLERS[platform];
  if (!info) throw new Error('plataforma inválida');

  let base = pickAgain ? null : findCleanInstaller(platform) ?? (await downloadCleanInstaller(platform));
  if (!base) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Instalador base',
      message: `Preciso do instalador limpo para ${info.label}`,
      detail:
        `O instalador dos seus amigos é feito a partir do instalador normal do app (${info.example}).\n\n` +
        `Não consegui baixar da página de Releases (github.com/${GITHUB_REPO}/releases). ` +
        'Baixe ele manualmente e salve em Downloads — o app encontra sozinho — ou mostre onde ele está agora.',
      buttons: ['Localizar arquivo…', 'Cancelar'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return null;
    const r = await dialog.showOpenDialog(win, {
      title: `Onde está o instalador limpo para ${info.label}?`,
      filters: [{ name: `Instalador ${info.label}`, extensions: [info.ext.slice(1)] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    base = r.filePaths[0];
  }
  if (base !== process.env.APPIMAGE) saveInstallerCache({ ...readInstallerCache(), [platform]: base });

  const safeName = String(cfg.host_name || 'host').replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'host';
  const save = await dialog.showSaveDialog(win, {
    title: `Salvar instalador para amigos (${info.label})`,
    defaultPath: path.join(app.getPath('downloads'), `Discord Local - ${safeName} (${info.label})${info.ext}`),
    filters: [{ name: `Instalador ${info.label}`, extensions: [info.ext.slice(1)] }],
  });
  if (save.canceled || !save.filePath) return null;
  let dest = save.filePath;
  if (!dest.toLowerCase().endsWith(info.ext.toLowerCase())) dest += info.ext;
  if (path.resolve(dest) === path.resolve(base)) throw new Error('Escolha outro nome: esse é o próprio instalador base');

  embed.stamp(base, dest, cfg);
  shell.showItemInFolder(dest);
  return dest;
}

app.whenReady().then(() => {
  store = new LocalStore(path.join(app.getPath('userData'), 'data'));
  setupMedia();
  setupIpc();
  createWindow();
  updater.init((st) => win?.webContents.send('update:status', st));
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Desliga o servidor embutido com calma (fecha sockets e o banco).
app.on('before-quit', (e) => {
  if (quitting || !host.status().running) return;
  e.preventDefault();
  quitting = true;
  host.stopHost().finally(() => app.quit());
});
