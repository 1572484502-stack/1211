const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vistaDesktop', {
  saveWav: (bytes, defaultName) => ipcRenderer.invoke('file:save-wav', { bytes, defaultName }),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close')
});
