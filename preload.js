const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderApi', {
  start: (payload) => ipcRenderer.invoke('recording:start', payload),
  stop: () => ipcRenderer.invoke('recording:stop'),
  openFolder: (outputPath) => ipcRenderer.invoke('recording:open-folder', outputPath),
  getSettings: () => ipcRenderer.invoke('recording:get-settings'),
  chooseOutputDir: () => ipcRenderer.invoke('recording:choose-output-dir'),
  chooseFfmpeg: () => ipcRenderer.invoke('recording:choose-ffmpeg'),
  appendUiLog: (message) => ipcRenderer.send('recording:append-ui-log', { message }),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('recording:event', listener);
    return () => {
      ipcRenderer.removeListener('recording:event', listener);
    };
  },
});
