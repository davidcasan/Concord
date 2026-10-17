// Janelas flutuantes (popups) para as transmissões: uma janela do Electron por transmissão, sempre no topo.
// O cliente abre cada uma com window.open('about:blank', 'concord-popup-<id>') e liga a faixa de vídeo
// já recebida ao <video> da janela, então não há conexão nem download extra.
const { screen } = require('electron');

const PREFIX = 'concord-popup-';

const isPopupRequest = ({ url, frameName }) => url === 'about:blank' && String(frameName || '').startsWith(PREFIX);

const popupOpenResult = () => ({
  action: 'allow',
  overrideBrowserWindowOptions: {
    title: 'Concord',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    minWidth: 240,
    minHeight: 135,
    webPreferences: { backgroundThrottling: false }, // o vídeo não pode travar com a janela atrás de outra
  },
});

// Se a posição salva ficou fora de todos os monitores (monitor removido, resolução trocada), traz a janela de volta.
function keepOnScreen(win) {
  const b = win.getBounds();
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    const overlapX = Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x);
    const overlapY = Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y);
    return overlapX >= 100 && overlapY >= 40;
  });
  if (!visible) win.center();
}

function setupPopupWindow(child) {
  child.removeMenu();
  child.setAlwaysOnTop(true, 'floating');
  child.webContents.on('will-navigate', (event) => event.preventDefault());
  child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  keepOnScreen(child);
}

module.exports = { PREFIX, isPopupRequest, popupOpenResult, setupPopupWindow };
