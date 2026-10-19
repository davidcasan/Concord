const { app, BrowserWindow, Menu, MessageChannelMain, desktopCapturer, ipcMain, screen, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PREFIX: POPUP_PREFIX, isPopupRequest, popupOpenResult, setupPopupWindow } = require('./popups.js');

app.setName('Concord');
app.setPath('userData', path.join(app.getPath('appData'), 'Minicord'));

const configFile = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  let defaults = {};
  let saved = {};
  try {
    defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'default-server.json'), 'utf8'));
  } catch {
    // Distribuições sem servidor pré-configurado continuam permitindo configuração manual.
  }
  try {
    saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    // Primeiro uso: mantém apenas os endereços padrão empacotados.
  }
  const config = { ...defaults, ...saved };
  if (saved.serverUrl && saved.serverUrl !== defaults.serverUrl && !Object.hasOwn(saved, 'fallbackServerUrl')) {
    config.fallbackServerUrl = null;
  }
  return config;
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

const config = readConfig();
let serverOrigin = null;
function validServerUrl(value) {
  try {
    const parsed = new URL(value);
    return /^https?:$/.test(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

const primaryUrl = validServerUrl(config.serverUrl);
const primaryIsLoopback = primaryUrl && ['localhost', '127.0.0.1'].includes(primaryUrl.hostname);
const serverUrls = [...new Set(
  (primaryIsLoopback ? [config.serverUrl, config.fallbackServerUrl] : [config.fallbackServerUrl, config.serverUrl])
    .filter((value) => typeof value === 'string'),
)]
  .map(validServerUrl)
  .filter(Boolean);

// Microfone/câmera exigem HTTPS. Libera só os servidores configurados pelo usuário.
const insecureServerOrigins = serverUrls
  .filter((url) => url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))
  .map((url) => url.origin);
if (insecureServerOrigins.length) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', insecureServerOrigins.join(','));
}

if (!app.requestSingleInstanceLock()) app.quit();

let win;
let pendingShare = null;

function showSetup(error) {
  win.loadFile(path.join(__dirname, 'setup.html'), {
    query: { current: config.serverUrl || '', error: error || '' },
  });
}

async function loadServer() {
  let lastError = null;
  for (const url of serverUrls) {
    try {
      const response = await fetch(new URL('/api/config', url.origin), {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        lastError = new Error(`o servidor respondeu HTTP ${response.status}`);
        continue;
      }
      serverOrigin = url.origin;
      await win.loadURL(url.origin);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError?.message || 'nenhum endereço de servidor foi configurado';
  showSetup(`Não foi possível conectar aos servidores configurados (${reason}).`);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Concord',
        submenu: [
          { label: 'Trocar servidor…', click: () => showSetup() },
          { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: () => loadServer() },
          { label: 'Ferramentas de desenvolvedor', accelerator: 'CmdOrCtrl+Shift+I', click: () => win.webContents.toggleDevTools() },
          { type: 'separator' },
          { label: 'Sair', role: 'quit' },
        ],
      },
      {
        label: 'Editar',
        submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
      },
      { label: 'Ver', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] },
    ]),
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    title: 'Concord',
    backgroundColor: '#313338',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // mantém a voz estável com a janela minimizada
    },
  });

  // Links externos abrem no navegador padrão.
  win.webContents.setWindowOpenHandler((details) => {
    if (isPopupRequest(details)) return popupOpenResult(); // janelas flutuantes das transmissões
    if (/^https?:/.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, details) => {
    if (String(details.frameName).startsWith(POPUP_PREFIX)) setupPopupWindow(child);
  });
  // Recarregar ou trocar de servidor encerra as capturas de tela (a página que as recebia não existe mais).
  win.webContents.on('did-navigate', () => stopAllCaptures());
  // Fechar a janela principal fecha os popups (senão o app não encerraria).
  win.on('closed', () => BrowserWindow.getAllWindows().forEach((w) => w.close()));
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:') || (serverOrigin && url.startsWith(serverOrigin))) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  loadServer();
}

app.whenReady().then(() => {
  const ses = session.defaultSession;

  // Pula a página de aviso do ngrok gratuito.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['ngrok-skip-browser-warning'] = '1';
    callback({ requestHeaders: details.requestHeaders });
  });

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const origin = (() => {
      try {
        return new URL(webContents.getURL()).origin;
      } catch {
        return null;
      }
    })();
    const allowed = ['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'speaker-selection'];
    callback(origin === serverOrigin && allowed.includes(permission));
  });

  // Chamado quando a página usa getDisplayMedia(): entrega a tela/janela escolhida no seletor do Concord.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const choice = pendingShare;
    pendingShare = null;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = (choice && sources.find((s) => s.id === choice.id)) || sources.find((s) => s.id.startsWith('screen:'));
      if (!source) return callback({});
      const streams = { video: source };
      // Áudio do sistema (loopback) só existe no Windows.
      if (choice?.audio && request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    } catch {
      callback({});
    }
  });

  ipcMain.handle('minicord:get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 400, height: 225 },
      fetchWindowIcons: true,
    });
    return sources
      .filter((s) => s.name !== 'Concord')
      .map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      }));
  });

  ipcMain.handle('minicord:select-source', (_e, id, audio) => {
    pendingShare = { id, audio: !!audio };
  });

  ipcMain.handle('minicord:capture-start', (event, id, sourceId, options) => startCapture(event.sender, id, sourceId, options));
  ipcMain.handle('minicord:capture-stop', (_e, id) => stopCapture(id));

  ipcMain.handle('minicord:system-audio-start', (event, source) => startSystemAudio(event.sender, source));
  ipcMain.handle('minicord:list-audio-apps', () => listAudioApps());
  ipcMain.handle('minicord:system-audio-stop', () => stopSystemAudio());

  ipcMain.handle('minicord:save-server', (_e, url) => {
    const parsed = validServerUrl(url);
    if (!parsed) throw new Error('Use um endereço http:// ou https://');
    config.serverUrl = parsed.origin;
    config.fallbackServerUrl = null;
    writeConfig(config);
    // Reinicia para aplicar as permissões do novo endereço.
    app.relaunch();
    app.exit(0);
  });

  buildMenu();
  createWindow();
});

// ---------- Áudio da transmissão ----------
// O minicord-audio.exe captura, a pedido, (a) todo o som do PC EXCETO o deste processo e dos filhos dele
// (onde toca a voz dos amigos, então ninguém se ouve de volta) ou (b) só o som de um aplicativo.
// A fonte pode ser trocada com a transmissão no ar: o novo capturador sobe primeiro e só então o antigo cai.
let audioProc = null;

const helperPath = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'minicord-audio.exe') : path.join(__dirname, 'native', 'minicord-audio.exe');

function captureArgs(source) {
  switch (source?.type) {
    case 'app': {
      const pid = Number(source.pid);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Aplicativo inválido.');
      return ['include', String(pid)];
    }
    case 'window': {
      const hwnd = /^window:(\d+):/.exec(String(source.windowId))?.[1];
      if (!hwnd) throw new Error('Janela inválida.');
      return ['include-window', hwnd];
    }
    default:
      return ['exclude', String(process.pid)];
  }
}

function stopSystemAudio() {
  const proc = audioProc;
  audioProc = null; // antes do kill, para o 'exit' não ser tratado como fim inesperado
  proc?.kill();
}

function startSystemAudio(sender, source) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Disponível só no Windows.'));
    let args;
    try {
      args = captureArgs(source);
    } catch (error) {
      return reject(error);
    }
    const proc = spawn(helperPath(), args, { windowsHide: true });
    // Primeira captura: já é a atual. Troca: continua a antiga até a nova confirmar que iniciou.
    if (!audioProc) audioProc = proc;
    let started = false;
    let errors = '';
    let leftover = Buffer.alloc(0);

    proc.stderr.on('data', (d) => {
      const text = d.toString();
      if (!started && text.startsWith('ok')) {
        started = true;
        const previous = audioProc;
        audioProc = proc;
        if (previous && previous !== proc) previous.kill();
        resolve();
      } else {
        errors += text;
      }
    });
    // PCM float32 estéreo: só repassa quadros completos (8 bytes cada), e só da captura atual.
    proc.stdout.on('data', (d) => {
      if (audioProc !== proc) return;
      const buf = leftover.length ? Buffer.concat([leftover, d]) : d;
      const usable = buf.length - (buf.length % 8);
      leftover = Buffer.from(buf.subarray(usable));
      if (usable && !sender.isDestroyed()) sender.send('minicord:system-audio-data', buf.subarray(0, usable));
    });
    proc.on('error', (err) => {
      if (audioProc === proc) audioProc = null;
      if (!started) reject(err);
    });
    proc.on('exit', (code) => {
      const wasCurrent = audioProc === proc;
      if (wasCurrent) audioProc = null;
      if (!started) reject(new Error(errors.trim() || `o capturador encerrou (código ${code})`));
      else if (wasCurrent && !sender.isDestroyed()) sender.send('minicord:system-audio-ended');
    });
  });
}

// Aplicativos com sessão de áudio ativa no dispositivo padrão (para o usuário escolher o que transmitir).
function listAudioApps() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return resolve([]);
    const proc = spawn(helperPath(), ['list'], { windowsHide: true });
    let out = '';
    let errors = '';
    const timer = setTimeout(() => proc.kill(), 5000);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (errors += d));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', async (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(errors.trim() || `falha ao listar aplicativos (código ${code})`));
      try {
        const apps = JSON.parse(out).filter((a) => a.pid !== process.pid); // o próprio Concord fica de fora
        resolve(
          await Promise.all(
            apps.map(async (a) => {
              const icon = await app.getFileIcon(a.exe, { size: 'normal' }).catch(() => null);
              const base = path.basename(a.exe, path.extname(a.exe));
              return {
                pid: a.pid,
                name: base.charAt(0).toUpperCase() + base.slice(1),
                active: a.active,
                icon: icon && !icon.isEmpty() ? icon.toDataURL() : null,
              };
            }),
          ),
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}

// ---------- Captura de tela própria ----------
// O minicord-capture.exe captura com DXGI Desktop Duplication e desenha o cursor ele mesmo. A captura do
// Chromium (Windows Graphics Capture) some com o cursor, na tela de quem transmite, em jogos em janela sem
// bordas em alguns Windows. Os quadros (I420) vão para a página por um MessagePort, um ou dois por vez:
// se a página atrasar, fica só o mais recente.
const FRAME_MAGIC = 0x3146434d; // "MCF1"
const captures = new Map();

const captureHelperPath = () =>
  app.isPackaged ? path.join(process.resourcesPath, 'minicord-capture.exe') : path.join(__dirname, 'native', 'minicord-capture.exe');

async function captureTarget(sourceId) {
  const hwnd = /^window:(\d+):/.exec(String(sourceId))?.[1];
  if (hwnd) return ['window', hwnd];
  if (!String(sourceId).startsWith('screen:')) throw new Error('Fonte inválida.');
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const displayId = sources.find((s) => s.id === sourceId)?.display_id;
  const display = screen.getAllDisplays().find((d) => String(d.id) === displayId) || screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  const center = screen.dipToScreenPoint({ x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) });
  return ['screen', String(Math.round(center.x)), String(Math.round(center.y))];
}

function sendFrame(capture, frame) {
  if (capture.inFlight >= 2) {
    capture.pending = frame;
    return;
  }
  capture.inFlight++;
  capture.port.postMessage(frame);
}

async function startCapture(sender, id, sourceId, { maxWidth, maxHeight, frameRate } = {}) {
  if (process.platform !== 'win32') throw new Error('Disponível só no Windows.');
  if (!fs.existsSync(captureHelperPath())) throw new Error('minicord-capture.exe não encontrado.');
  const size = (value, fallback) => String(Math.max(2, Math.round(Number(value) || fallback)));
  const args = [...(await captureTarget(sourceId)), size(maxWidth, 1920), size(maxHeight, 1080), size(frameRate, 30)];
  return new Promise((resolve, reject) => {
    const proc = spawn(captureHelperPath(), args, { windowsHide: true });
    const { port1, port2 } = new MessageChannelMain();
    const capture = { proc, port: port1, inFlight: 0, pending: null };
    captures.set(id, capture);
    port1.on('message', () => {
      capture.inFlight = Math.max(0, capture.inFlight - 1); // a página terminou um quadro
      if (capture.pending) {
        const next = capture.pending;
        capture.pending = null;
        sendFrame(capture, next);
      }
    });
    port1.start();

    let started = false;
    let errors = '';
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      if (!started && text.startsWith('ok')) {
        started = true;
        if (sender.isDestroyed()) return proc.kill();
        sender.postMessage('minicord:capture-port', { id }, [port2]);
        resolve();
      } else {
        errors += text;
      }
    });

    // Cabeçalho de 12 bytes + I420; cada quadro vai para um buffer próprio (sem concatenar pedaços).
    const header = Buffer.alloc(12);
    let headerFill = 0;
    let frame = null;
    let frameFill = 0;
    proc.stdout.on('data', (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (!frame) {
          const n = Math.min(12 - headerFill, chunk.length - offset);
          chunk.copy(header, headerFill, offset, offset + n);
          headerFill += n;
          offset += n;
          if (headerFill < 12) break;
          headerFill = 0;
          if (header.readUInt32LE(0) !== FRAME_MAGIC) return proc.kill();
          frame = { width: header.readUInt16LE(4), height: header.readUInt16LE(6), data: Buffer.allocUnsafe(header.readUInt32LE(8)) };
          frameFill = 0;
        }
        const n = Math.min(frame.data.length - frameFill, chunk.length - offset);
        chunk.copy(frame.data, frameFill, offset, offset + n);
        frameFill += n;
        offset += n;
        if (frameFill === frame.data.length) {
          if (started && captures.get(id) === capture) sendFrame(capture, frame);
          frame = null;
        }
      }
    });

    proc.on('error', (err) => {
      if (!started) reject(err);
    });
    proc.on('exit', (code) => {
      if (captures.get(id) === capture) captures.delete(id);
      if (!started) reject(new Error(errors.trim() || `o capturador encerrou (código ${code})`));
      // Avisa a página (janela fechada, monitor desconectado...) para encerrar a transmissão dessa tela.
      port1.postMessage({ ended: true, reason: errors.trim() });
      port1.close();
    });
  });
}

function stopCapture(id) {
  const capture = captures.get(id);
  captures.delete(id);
  capture?.proc.kill();
}

const stopAllCaptures = () => [...captures.keys()].forEach(stopCapture);

app.on('will-quit', stopSystemAudio);
app.on('will-quit', stopAllCaptures);

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
