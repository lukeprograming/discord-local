const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  loadProfile: () => ipcRenderer.invoke('store:loadProfile'),
  saveProfile: (p) => ipcRenderer.invoke('store:saveProfile', p),
  loadMessages: (convId) => ipcRenderer.invoke('store:loadMessages', convId),
  appendMessages: (convId, msgs) => ipcRenderer.invoke('store:appendMessages', convId, msgs),
  loadOutbox: () => ipcRenderer.invoke('store:loadOutbox'),
  saveOutbox: (list) => ipcRenderer.invoke('store:saveOutbox', list),
  openDataDir: () => ipcRenderer.invoke('store:openDataDir'),
  info: () => ipcRenderer.invoke('app:info'),
  flash: () => ipcRenderer.invoke('app:flash'),
  onChooseScreen: (cb) => {
    const listener = (_e, sources) => cb(sources);
    ipcRenderer.on('screen:choose', listener);
    return () => ipcRenderer.removeListener('screen:choose', listener);
  },
  screenPicked: (id) => ipcRenderer.invoke('screen:picked', id),
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
