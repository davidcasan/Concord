const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('minicordDesktop', {
  isDesktop: true,
  getSources: () => ipcRenderer.invoke('minicord:get-sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('minicord:select-source', id, audio),
  saveServer: (url) => ipcRenderer.invoke('minicord:save-server', url),
  // Áudio da transmissão (PCM float32 estéreo 48 kHz). `source`: { type: 'system' | 'app' | 'window', pid?, windowId? }.
  // Chamar de novo com a captura ativa troca a fonte sem interromper o fluxo.
  startSystemAudio: (source) => ipcRenderer.invoke('minicord:system-audio-start', source),
  listAudioApps: () => ipcRenderer.invoke('minicord:list-audio-apps'),
  stopSystemAudio: () => ipcRenderer.invoke('minicord:system-audio-stop'),
  onSystemAudioData: (cb) => subscribe('minicord:system-audio-data', cb),
  onSystemAudioEnded: (cb) => subscribe('minicord:system-audio-ended', cb),
});
