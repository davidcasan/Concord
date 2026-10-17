const { app, BrowserWindow, Menu, desktopCapturer, ipcMain, session, shell } = require('electron');
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

app.on('will-quit', stopSystemAudio);

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => app.quit());
