// Janelas flutuantes (popups) para as transmissões: uma janela do Electron por transmissão, sem borda e sempre no topo.
// O cliente abre cada uma com window.open('about:blank', 'concord-popup-<id>') e liga a faixa de vídeo
// já recebida ao <video> da janela, então não há conexão nem download extra. Sem barra de título, o cliente
// cuida de arrastar (clicando no vídeo) e do botão de fechar; o redimensionamento continua pelas bordas.
const { screen } = require('electron');

const PREFIX = 'concord-popup-';

const isPopupRequest = ({ url, frameName }) => url === 'about:blank' && String(frameName || '').startsWith(PREFIX);

const popupOpenResult = () => ({
  action: 'allow',
  overrideBrowserWindowOptions: {
    title: 'Concord',
    autoHideMenuBar: true,
    frame: false,
    alwaysOnTop: true,
    fullscreenable: true,
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

// Nível mais alto disponível: fica acima de outras janelas "sempre no topo" e de jogos em tela cheia sem borda.
const keepOnTop = (win) => {
  if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
};

function setupPopupWindow(child) {
  child.removeMenu();
  keepOnTop(child);
  // O Windows às vezes tira o "topmost" quando outra janela topmost (jogo, overlay) ganha o foco: reafirma.
  child.on('blur', () => keepOnTop(child));
  child.on('show', () => keepOnTop(child));
  child.on('leave-html-full-screen', () => keepOnTop(child));
  child.webContents.on('will-navigate', (event) => event.preventDefault());
  child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  keepOnScreen(child);
}

module.exports = { PREFIX, isPopupRequest, popupOpenResult, setupPopupWindow };
