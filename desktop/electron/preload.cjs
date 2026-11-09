const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  loadProfile: () => ipcRenderer.invoke('store:loadProfile'),
  saveProfile: (p) => ipcRenderer.invoke('store:saveProfile', p),
  loadMessages: (convId) => ipcRenderer.invoke('store:loadMessages', convId),
  appendMessages: (convId, msgs) => ipcRenderer.invoke('store:appendMessages', convId, msgs),
  loadOutbox: () => ipcRenderer.invoke('store:loadOutbox'),
  saveOutbox: (list) => ipcRenderer.invoke('store:saveOutbox', list),
  openDataDir: () => ipcRenderer.invoke('store:openDataDir'),
  fetchUrl: (url, kind) => ipcRenderer.invoke('net:fetchUrl', url, kind),
  turnInfo: (hostIp) => ipcRenderer.invoke('turn:info', hostIp),
  spotifyLogin: () => ipcRenderer.invoke('spotify:login'),
  spotifyStatus: () => ipcRenderer.invoke('spotify:status'),
  spotifyLogout: () => ipcRenderer.invoke('spotify:logout'),
  sharePick: () => ipcRenderer.invoke('share:pick'),
  shareList: (root, rel) => ipcRenderer.invoke('share:list', root, rel),
  shareUpload: (root, rel, serverUrl, token, to) => ipcRenderer.invoke('share:upload', root, rel, serverUrl, token, to),
  shareDownload: (key, url, name) => ipcRenderer.invoke('share:download', key, url, name),
  shareShow: (p) => ipcRenderer.invoke('share:show', p),
  onShareProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('share:progress', listener);
    return () => ipcRenderer.removeListener('share:progress', listener);
  },
  recStart: (kind, ext) => ipcRenderer.invoke('rec:start', kind, ext),
  recWrite: (id, bytes) => ipcRenderer.invoke('rec:write', id, bytes),
  recFinish: (id) => ipcRenderer.invoke('rec:finish', id),
  recShow: (p) => ipcRenderer.invoke('rec:show', p),
  hotkeysKind: () => ipcRenderer.invoke('hotkeys:kind'),
  hotkeysSet: (bindings) => ipcRenderer.invoke('hotkeys:set', bindings),
  hotkeysClear: () => ipcRenderer.invoke('hotkeys:clear'),
  onHotkey: (cb) => {
    const listener = (_e, h) => cb(h);
    ipcRenderer.on('hotkey', listener);
    return () => ipcRenderer.removeListener('hotkey', listener);
  },
  // ---- arquivos do chat ----
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  fileLocal: (convId, att) => ipcRenderer.invoke('file:local', convId, att),
  fileDownload: (serverUrl, token, convId, att) => ipcRenderer.invoke('file:download', serverUrl, token, convId, att),
  fileKeepSent: (convId, att, source) => ipcRenderer.invoke('file:keepSent', convId, att, source),
  fileRead: (p) => ipcRenderer.invoke('file:read', p),
  fileOpen: (p) => ipcRenderer.invoke('file:open', p),
  fileShow: (p) => ipcRenderer.invoke('file:show', p),
  fileSaveAs: (p) => ipcRenderer.invoke('file:saveAs', p),
  onFileProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('file:progress', listener);
    return () => ipcRenderer.removeListener('file:progress', listener);
  },
  info: () => ipcRenderer.invoke('app:info'),
  flash: () => ipcRenderer.invoke('app:flash'),
  focusMain: () => ipcRenderer.invoke('app:focus'),
  idleSeconds: () => ipcRenderer.invoke('app:idle'),
  setFullscreen: (on) => ipcRenderer.invoke('app:fullscreen', on),
  winState: () => ipcRenderer.invoke('win:state'),
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winToggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winSetNativeFrame: (on) => ipcRenderer.invoke('win:setNativeFrame', on),
  onWinMaximized: (cb) => {
    const listener = (_e, max) => cb(max);
    ipcRenderer.on('win:maximized', listener);
    return () => ipcRenderer.removeListener('win:maximized', listener);
  },
  onChooseScreen: (cb) => {
    const listener = (_e, sources) => cb(sources);
    ipcRenderer.on('screen:choose', listener);
    return () => ipcRenderer.removeListener('screen:choose', listener);
  },
  screenPicked: (id) => ipcRenderer.invoke('screen:picked', id),
  // Só no Linux (no Windows o áudio vem direto do getDisplayMedia).
  ...(process.platform === 'linux' && {
    shareAudioApps: () => ipcRenderer.invoke('share-audio:apps'),
    shareAudioStart: (only, includeVoice) => ipcRenderer.invoke('share-audio:start', only, includeVoice),
    shareAudioStop: () => ipcRenderer.invoke('share-audio:stop'),
  }),
  interfaces: () => ipcRenderer.invoke('net:interfaces'),
  hostStart: (cfg) => ipcRenderer.invoke('host:start', cfg),
  hostStop: () => ipcRenderer.invoke('host:stop'),
  hostStatus: () => ipcRenderer.invoke('host:status'),
  embedded: () => ipcRenderer.invoke('embed:read'),
  exportConnector: (platform, cfg, pickAgain) => ipcRenderer.invoke('host:export', platform, cfg, pickAgain),
  updateStatus: () => ipcRenderer.invoke('update:get'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  onExportProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },
  onUpdateStatus: (cb) => {
    const listener = (_e, st) => cb(st);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
});
