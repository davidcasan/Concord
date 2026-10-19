const { contextBridge, ipcRenderer, webFrame } = require('electron');

const subscribe = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

// Última tela/janela escolhida no seletor do Concord, consumida pelo getDisplayMedia seguinte.
let selection = null;

contextBridge.exposeInMainWorld('minicordDesktop', {
  isDesktop: true,
  getSources: () => ipcRenderer.invoke('minicord:get-sources'),
  selectSource: (id, audio) => {
    selection = { id: String(id), audio: !!audio };
    return ipcRenderer.invoke('minicord:select-source', id, audio);
  },
  takeSelection: () => {
    const current = selection;
    selection = null;
    return current;
  },
  // Captura de tela própria (minicord-capture.exe). Os quadros chegam por um MessagePort (ver abaixo).
  startCapture: (id, sourceId, options) => ipcRenderer.invoke('minicord:capture-start', id, sourceId, options),
  stopCapture: (id) => ipcRenderer.invoke('minicord:capture-stop', id),
  saveServer: (url) => ipcRenderer.invoke('minicord:save-server', url),
  // Áudio da transmissão (PCM float32 estéreo 48 kHz). `source`: { type: 'system' | 'app' | 'window', pid?, windowId? }.
  // Chamar de novo com a captura ativa troca a fonte sem interromper o fluxo.
  startSystemAudio: (source) => ipcRenderer.invoke('minicord:system-audio-start', source),
  listAudioApps: () => ipcRenderer.invoke('minicord:list-audio-apps'),
  stopSystemAudio: () => ipcRenderer.invoke('minicord:system-audio-stop'),
  onSystemAudioData: (cb) => subscribe('minicord:system-audio-data', cb),
  onSystemAudioEnded: (cb) => subscribe('minicord:system-audio-ended', cb),
});

// MessagePorts não passam pelo contextBridge: seguem para a página por window.postMessage.
ipcRenderer.on('minicord:capture-port', (event, { id }) => {
  window.postMessage({ type: 'minicord-capture-port', id }, '*', event.ports);
});

/**
 * Roda no mundo da página: quando a tela foi escolhida no seletor do Concord, o getDisplayMedia passa a
 * devolver o vídeo do minicord-capture.exe em vez da captura do Chromium (que some com o cursor em jogos
 * em janela sem bordas em alguns Windows). Sem o capturador, ou se ele falhar, segue a captura do Chromium.
 */
function installNativeScreenCapture() {
  const api = window.minicordDesktop;
  const media = navigator.mediaDevices;
  if (!api || !media?.getDisplayMedia || typeof MediaStreamTrackGenerator !== 'function' || typeof VideoFrame !== 'function') return;

  const browserCapture = media.getDisplayMedia.bind(media);
  const waitingPorts = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'minicord-capture-port') return;
    const port = event.ports?.[0];
    const resolve = waitingPorts.get(event.data.id);
    if (resolve) resolve(port);
    else port?.close();
  });
  const number = (c, fallback) => (typeof c === 'number' ? c : (c?.max ?? c?.ideal ?? c?.exact ?? fallback));
  const colorSpace = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'smpte170m', fullRange: false };

  media.getDisplayMedia = async function getDisplayMedia(constraints = {}) {
    const selected = api.takeSelection();
    if (!selected || selected.audio || constraints.audio) return browserCapture(constraints);
    const video = typeof constraints.video === 'object' ? constraints.video : {};
    const options = { maxWidth: number(video.width, 1920), maxHeight: number(video.height, 1080), frameRate: number(video.frameRate, 30) };
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const portReady = new Promise((resolve) => waitingPorts.set(id, resolve));
    try {
      await api.startCapture(id, selected.id, options);
    } catch (err) {
      waitingPorts.delete(id);
      console.warn('[Concord] captura própria indisponível, usando a do navegador:', err);
      return browserCapture(constraints);
    }
    const port = await portReady;
    waitingPorts.delete(id);

    const track = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = track.writable.getWriter();
    const start = performance.now();
    let size = {};
    let ended = false;
    let firstFrame;
    const gotFirstFrame = new Promise((resolve) => (firstFrame = resolve));
    const stopTrack = track.stop.bind(track);
    const finish = () => {
      if (ended) return;
      ended = true;
      port.close();
      api.stopCapture(id);
      writer.close().catch(() => {});
      stopTrack();
    };

    port.onmessage = async ({ data }) => {
      if (data.ended) {
        // Janela fechada, monitor desconectado...: encerra esta tela como o navegador faria.
        if (!ended) {
          finish();
          track.dispatchEvent(new Event('ended'));
        }
        firstFrame(false);
        return;
      }
      if (ended) return;
      try {
        size = { width: data.width, height: data.height };
        const timestamp = Math.round((performance.now() - start) * 1000);
        await writer.write(new VideoFrame(data.data, { format: 'I420', codedWidth: data.width, codedHeight: data.height, timestamp, colorSpace }));
        firstFrame(true);
      } catch {
        // quadro perdido: segue com o próximo
      }
      if (!ended) port.postMessage('ack');
    };

    track.stop = finish;
    const settings = track.getSettings.bind(track);
    track.getSettings = () => ({
      ...settings(),
      ...size,
      frameRate: options.frameRate,
      displaySurface: selected.id.startsWith('window:') ? 'window' : 'monitor',
    });

    const timeout = setTimeout(() => firstFrame(false), 5000);
    const ok = await gotFirstFrame;
    clearTimeout(timeout);
    if (!ok) {
      finish();
      console.warn('[Concord] a captura própria não enviou imagem, usando a do navegador.');
      return browserCapture(constraints);
    }
    return new MediaStream([track]);
  };
}

if (typeof contextBridge.executeInMainWorld === 'function') {
  contextBridge.executeInMainWorld({ func: installNativeScreenCapture });
} else {
  webFrame.executeJavaScript(`(${installNativeScreenCapture})()`);
}
