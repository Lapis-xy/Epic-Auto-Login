const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('vault', {
  list: () => invoke('vault:list'),
  add: (data) => invoke('vault:add', data),
  update: (id, data) => invoke('vault:update', id, data),
  remove: (id) => invoke('vault:remove', id),
  pickIcon: () => invoke('icon:pick'),
  fill: (id) => invoke('preset:fill', id),
  stop: () => invoke('preset:stop'),
  copy: (id, field) => invoke('secret:copy', id, field),
  calibGet: () => invoke('calib:get'),
  calibCapture: (field) => invoke('calib:capture', field),
  calibClear: () => invoke('calib:clear'),
  onStatus: (callback) => {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('status', listener);
    return () => ipcRenderer.removeListener('status', listener);
  },
});