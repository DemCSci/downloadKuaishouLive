const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderApi', {
  start: (url) => ipcRenderer.invoke('recording:start', url),
  stop: () => ipcRenderer.invoke('recording:stop'),
  openFolder: (outputPath) => ipcRenderer.invoke('recording:open-folder', outputPath),
  getSettings: () => ipcRenderer.invoke('recording:get-settings'),
  chooseOutputDir: () => ipcRenderer.invoke('recording:choose-output-dir'),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('recording:event', listener);
    return () => {
      ipcRenderer.removeListener('recording:event', listener);
    };
  },
});
