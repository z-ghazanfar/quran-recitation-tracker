const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tarteelDesktopAudio', {
  isAvailable: process.platform === 'darwin',
  getInfo(options) {
    return ipcRenderer.invoke('tarteel:native-info', options);
  },
  start(options) {
    return ipcRenderer.invoke('tarteel:native-start', options);
  },
  stop() {
    return ipcRenderer.invoke('tarteel:native-stop');
  },
  onEvent(handler) {
    const listener = (_event, payload) => {
      handler(payload);
    };

    ipcRenderer.on('tarteel:native-event', listener);

    return () => {
      ipcRenderer.removeListener('tarteel:native-event', listener);
    };
  },
});
