const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, powerMonitor, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { LocalStore } = require('./store.cjs');
const host = require('./host.cjs');
const embed = require('./embed.cjs');
const updater = require('./updater.cjs');
const linuxAudio = require('./linux-audio.cjs');
const { Files } = require('./files.cjs');
const { fetchUrl } = require('./fetch-url.cjs');
const { createHotkeys, hasKde } = require('./hotkeys.cjs');
const { Recordings } = require('./recordings.cjs');
const share = require('./share.cjs');
const { TurnServer, routeIp, preferredVpnIp } = require('./turn.cjs');

// Releases de onde vêm as atualizações e os instaladores limpos para exportar.
const GITHUB_REPO = 'lukeprograming/discord-local';

// --profile=nome separa os dados: permite abrir duas contas na mesma máquina para testar.
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1].replace(/[^a-zA-Z0-9_-]/g, '') : '';
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `discord-local-${profile}`));
// Testes visuais: --test-bounds=x,y,largura,altura abre a janela nesse lugar (ex.: no
// segundo monitor) sem roubar o foco de quem está usando o PC. No Wayland precisa de
// --ozone-platform=x11 para a posição valer.
const testBoundsArg = process.argv.find((a) => a.startsWith('--test-bounds='));
const testBounds = testBoundsArg && testBoundsArg.split('=')[1].split(',').map(Number);

// Uma cópia por perfil: duas tentariam subir o mesmo servidor e mexer nos mesmos arquivos.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Sem isso o Chromium esconde o IP local atrás de um nome .local (mDNS),
// que não resolve pela VPN, e o WebRTC não conecta.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Captura de tela no Wayland via xdg-desktop-portal + PipeWire.
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

let win = null;
let store = null;
let files = null;
let recordings = null;
// Retransmissor pros celulares da mesma casa (o WebRTC do Android não usa a VPN).
const turn = new TurnServer();
let turnStarted = null;
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
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // calls continuam fluindo com a janela minimizada
    },
    ...(testBounds?.length === 4 && testBounds.every(Number.isFinite)
      ? { x: testBounds[0], y: testBounds[1], width: testBounds[2], height: testBounds[3], show: false }
      : {}),
  });
  if (testBounds) win.once('ready-to-show', () => win.showInactive());

  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Links clicados no chat abrem no navegador, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // Miniatura da transmissão (src/mini.ts): about:blank que o renderer preenche.
    if (frameName === MINI_NAME && (url === 'about:blank' || url === '')) {
      return { action: 'allow', overrideBrowserWindowOptions: miniWindowOptions() };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, { frameName }) => {
    if (frameName === MINI_NAME) setupMini(child);
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // F11: tela cheia da janela inteira (como no navegador).
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });
  win.on('closed', () => {
    win = null;
    for (const w of BrowserWindow.getAllWindows()) w.close(); // a miniatura vai junto
  });
}

// ---- miniatura da transmissão (sempre por cima) ----

const MINI_NAME = 'dl-mini';
const MINI_TITLE = 'Discord Local — mini';

function miniWindowOptions() {
  return {
    width: 480,
    height: 270,
    minWidth: 200,
    minHeight: 113,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    title: MINI_TITLE,
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false },
  };
}

function setupMini(child) {
  child.setAlwaysOnTop(true, 'screen-saver');
  child.setVisibleOnAllWorkspaces(true);
  child.on('page-title-updated', (e) => e.preventDefault());
  child.webContents.on('will-navigate', (e) => e.preventDefault());
  child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // No Wayland o compositor ignora o "sempre no topo" pedido pelo app; no KDE dá pra
  // pedir direto ao KWin com um script.
  if (process.platform === 'linux') setTimeout(() => kwinKeepAbove(MINI_TITLE), 400);
}

function kwinKeepAbove(title) {
  if (!/KDE/i.test(process.env.XDG_CURRENT_DESKTOP || '')) return;
  const { execFile } = require('node:child_process');
  const name = 'discord-local-mini';
  const file = path.join(app.getPath('temp'), 'discord-local-mini-kwin.js');
  try {
    fs.writeFileSync(
      file,
      `for (const w of workspace.windowList()) {\n` +
        `  if (w.caption.startsWith(${JSON.stringify(title)})) { w.keepAbove = true; w.onAllDesktops = true; }\n` +
        `}\n`,
    );
  } catch {
    return;
  }
  const call = (objPath, method, ...args) =>
    new Promise((resolve) =>
      execFile(
        'dbus-send',
        ['--session', '--print-reply', '--dest=org.kde.KWin', objPath, method, ...args],
        { timeout: 3000 },
        (err, out) => resolve(err ? '' : out),
      ),
    );
  (async () => {
    await call('/Scripting', 'org.kde.kwin.Scripting.unloadScript', `string:${name}`);
    const out = await call('/Scripting', 'org.kde.kwin.Scripting.loadScript', `string:${file}`, `string:${name}`);
    const id = /int32 (-?\d+)/.exec(out)?.[1];
    if (!id || id === '-1') return;
    await call(`/Scripting/Script${id}`, 'org.kde.kwin.Script.run');
    setTimeout(() => call('/Scripting', 'org.kde.kwin.Scripting.unloadScript', `string:${name}`), 1000);
  })();
}

function setupMedia() {
  const ses = session.defaultSession;
  // O player embutido do YouTube recusa tocar sem Referer (erro 153), e páginas
  // file:// não mandam um. O Android (http://localhost) já manda sozinho.
  ses.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube-nocookie.com/*', 'https://www.youtube.com/*'] },
    (details, cb) => {
      if (!details.requestHeaders.Referer) details.requestHeaders.Referer = 'http://localhost/';
      cb({ requestHeaders: details.requestHeaders });
    },
  );
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
  ipcMain.handle('net:fetchUrl', (_e, url, kind) => fetchUrl(url, kind));
  // ---- Spotify: login na página do próprio Spotify (o player embutido usa essa sessão) ----
  const spotifyLogged = async () =>
    (await session.defaultSession.cookies.get({ domain: 'spotify.com' })).some((c) => c.name === 'sp_dc');
  ipcMain.handle('spotify:status', () => spotifyLogged());
  ipcMain.handle('spotify:logout', async () => {
    for (const c of await session.defaultSession.cookies.get({ domain: 'spotify.com' })) {
      const url = `https://${c.domain.replace(/^\./, '')}${c.path}`;
      await session.defaultSession.cookies.remove(url, c.name).catch(() => {});
    }
  });
  ipcMain.handle('spotify:login', () =>
    new Promise((resolve) => {
      const w = new BrowserWindow({
        parent: win ?? undefined,
        width: 480,
        height: 760,
        title: 'Entrar no Spotify',
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: { sandbox: true, contextIsolation: true },
      });
      let done = false;
      const finish = async () => {
        if (done) return;
        done = true;
        const ok = await spotifyLogged();
        if (!w.isDestroyed()) w.close();
        resolve(ok);
      };
      // Depois do login o Spotify manda pro open.spotify.com: aí já tem a sessão.
      w.webContents.on('did-navigate', async (_e, url) => {
        if (/^https:\/\/open\.spotify\.com\//.test(url) && (await spotifyLogged())) finish();
      });
      w.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\/(accounts|www|open)\.spotify\.com\//.test(url)) w.loadURL(url);
        return { action: 'deny' };
      });
      w.on('closed', () => {
        if (!done) {
          done = true;
          spotifyLogged().then(resolve);
        }
      });
      w.loadURL('https://accounts.spotify.com/login?continue=' + encodeURIComponent('https://open.spotify.com/'));
    }),
  );
  // ---- retransmissor TURN ----
  ipcMain.handle('turn:info', async (_e, hostIp) => {
    turnStarted ??= turn.start(3478);
    if (!(await turnStarted)) return null;
    turn.relayIp = (hostIp && (await routeIp(hostIp))) || preferredVpnIp();
    return turn.info();
  });
  // ---- pasta compartilhada ----
  ipcMain.handle('share:pick', () => share.pickFolder(win));
  ipcMain.handle('share:list', (_e, root, rel) => share.list(root, rel));
  ipcMain.handle('share:upload', (_e, root, rel, serverUrl, token, to) => share.upload(root, rel, serverUrl, token, to));
  ipcMain.handle('share:download', (_e, key, url, name) =>
    share.download(url, name, (done, total) => win?.webContents.send('share:progress', { key, done, total })),
  );
  ipcMain.handle('share:show', (_e, p) => share.show(p));
  // ---- gravações / clipes ----
  ipcMain.handle('rec:start', (_e, kind, ext) => recordings.start(kind, ext));
  ipcMain.handle('rec:write', (_e, id, bytes) => recordings.write(id, bytes));
  ipcMain.handle('rec:finish', (_e, id) => recordings.finish(id));
  ipcMain.handle('rec:show', (_e, p) => recordings.show(p));
  // ---- atalhos globais (só enquanto estou numa call) ----
  const hotkeys = createHotkeys((name, pressed) => win?.webContents.send('hotkey', { name, pressed }));
  ipcMain.handle('hotkeys:kind', () => (hasKde() ? 'kde' : 'basic'));
  ipcMain.handle('hotkeys:set', (_e, bindings) => hotkeys.set(bindings));
  ipcMain.handle('hotkeys:clear', () => hotkeys.clear());
  app.on('will-quit', () => {
    hotkeys.clear();
  });
  // ---- arquivos do chat ----
  ipcMain.handle('file:local', (_e, convId, att) => files.local(convId, att));
  ipcMain.handle('file:download', (_e, serverUrl, token, convId, att) => files.download(serverUrl, token, convId, att));
  ipcMain.handle('file:keepSent', (_e, convId, att, source) => files.keepSent(convId, att, source));
  ipcMain.handle('file:read', (_e, p) => files.read(p));
  ipcMain.handle('file:open', (_e, p) => files.open(p));
  ipcMain.handle('file:show', (_e, p) => files.show(p));
  ipcMain.handle('file:saveAs', (_e, p) => files.saveAs(win, p));
  ipcMain.handle('store:openDataDir', () => shell.openPath(store.dir));
  ipcMain.handle('screen:picked', (_e, id) => pendingPick?.(id));
  // Áudio do PC na transmissão (Linux): fonte virtual do PipeWire sem o som do próprio app.
  const ownPids = () => [process.pid, ...app.getAppMetrics().map((m) => m.pid)];
  ipcMain.handle('share-audio:apps', () => linuxAudio.listApps(ownPids));
  ipcMain.handle('share-audio:start', (_e, only, includeVoice) => linuxAudio.start(ownPids, only, includeVoice));
  ipcMain.handle('share-audio:stop', () => linuxAudio.stop());
  ipcMain.handle('app:info', () => ({ platform: process.platform, profile, version: app.getVersion() }));
  ipcMain.handle('app:idle', () => powerMonitor.getSystemIdleTime());
  ipcMain.handle('app:fullscreen', (_e, on) => win?.setFullScreen(!!on));
  ipcMain.handle('app:focus', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
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
  files = new Files(store.dir, (ch, d) => win?.webContents.send(ch, d));
  recordings = new Recordings(store.dir);
  setupMedia();
  setupIpc();
  createWindow();
  updater.init((st) => win?.webContents.send('update:status', st));
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('will-quit', () => {
  turn.stop();
  linuxAudio.stopSync();
  recordings?.closeAll();
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
