// Janelas flutuantes das transmissões (app desktop). Cada transmissão abre numa janela do Electron própria,
// sempre no topo, onde o <video> recebe a MESMA faixa que a janela principal já recebe: sem download extra.
import { useSyncExternalStore } from 'react';

const POPUP_PREFIX = 'concord-popup-'; // precisa bater com desktop/popups.js
const GEOMETRY_KEY = 'minicord.popups';
const DEFAULT_SIZE = { width: 480, height: 270 };

const entries = new Map(); // id da transmissão -> { win, video, track, geomKey, timer }
const listeners = new Set();
let openIds = new Set();

function emit() {
  openIds = new Set(entries.keys());
  listeners.forEach((l) => l());
}
const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Ids das transmissões abertas em janela (atualiza o React quando abre ou fecha). */
export const useOpenPopupIds = () => useSyncExternalStore(subscribe, () => openIds);

export const popupsAvailable = () => typeof window !== 'undefined' && !!window.minicordDesktop?.isDesktop;

function loadGeometry(geomKey) {
  try {
    return JSON.parse(localStorage.getItem(GEOMETRY_KEY) || '{}')[geomKey] || null;
  } catch {
    return null;
  }
}

function saveGeometry(geomKey, win) {
  try {
    if (win.outerWidth < 100 || win.outerHeight < 60) return;
    const all = JSON.parse(localStorage.getItem(GEOMETRY_KEY) || '{}');
    all[geomKey] = { x: win.screenX, y: win.screenY, width: win.outerWidth, height: win.outerHeight };
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(all));
  } catch {
    // posição não é essencial
  }
}

const STYLE = `
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
  .label { position: fixed; left: 8px; bottom: 8px; max-width: calc(100% - 16px); padding: 4px 10px; border-radius: 4px;
    background: rgba(0, 0, 0, 0.65); color: #fff; font: 600 13px "Segoe UI", sans-serif; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; opacity: 0; transition: opacity 0.15s; pointer-events: none; }
  body:hover .label { opacity: 1; }
  body { cursor: grab; }
  body.dragging { cursor: grabbing; }
  .close { position: fixed; top: 6px; right: 6px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px;
    background: rgba(0, 0, 0, 0.65); color: #fff; font: 18px/28px "Segoe UI", sans-serif; cursor: pointer;
    opacity: 0; transition: opacity 0.15s, background 0.15s; }
  body:hover .close { opacity: 1; }
  .close:hover { background: #da373c; }
`;

// A janela não tem barra de título: arrastar em qualquer ponto do vídeo move a janela.
function enableDrag(win, doc) {
  let start = null;
  let frame = 0;
  let next = null;
  doc.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.close') || doc.fullscreenElement) return;
    start = { x: e.screenX, y: e.screenY, left: win.screenX, top: win.screenY };
    doc.body.setPointerCapture(e.pointerId);
  });
  doc.addEventListener('pointermove', (e) => {
    if (!start) return;
    next = [start.left + e.screenX - start.x, start.top + e.screenY - start.y];
    if (next[0] !== start.left || next[1] !== start.top) doc.body.classList.add('dragging');
    if (!frame) {
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        if (next) win.moveTo(next[0], next[1]);
      });
    }
  });
  const stop = () => {
    start = null;
    next = null;
    doc.body.classList.remove('dragging');
  };
  doc.addEventListener('pointerup', stop);
  doc.addEventListener('pointercancel', stop);
}

function build(entry, title, track) {
  const doc = entry.win.document;
  doc.title = title;
  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  const video = doc.createElement('video');
  video.autoplay = true;
  video.muted = true; // o som toca na janela principal, com os volumes de cada pessoa
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  // No documento (não no <video>): a captura do ponteiro durante o arraste redireciona o clique para o <body>.
  doc.addEventListener('dblclick', (e) => {
    if (e.target.closest('.close')) return;
    if (doc.fullscreenElement) doc.exitFullscreen();
    else doc.documentElement.requestFullscreen?.();
  });
  // Primeira vez (sem posição salva): ajusta a altura da janela à proporção do vídeo.
  video.addEventListener('loadedmetadata', () => {
    if (entry.fitted || !video.videoWidth) return;
    entry.fitted = true;
    if (loadGeometry(entry.geomKey)) return;
    const wanted = Math.round((entry.win.innerWidth * video.videoHeight) / video.videoWidth);
    entry.win.resizeTo(entry.win.outerWidth, entry.win.outerHeight + (wanted - entry.win.innerHeight));
  });
  const label = doc.createElement('div');
  label.className = 'label';
  label.textContent = title;
  const close = doc.createElement('button');
  close.className = 'close';
  close.title = 'Fechar';
  close.textContent = '✕';
  close.addEventListener('click', () => entry.win.close());
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !doc.fullscreenElement) entry.win.close();
  });
  doc.body.append(video, label, close);
  enableDrag(entry.win, doc);
  entry.video = video;
  video.play().catch(() => {});
}

function cleanup(id) {
  const entry = entries.get(id);
  if (!entry) return;
  clearInterval(entry.timer);
  if (!entry.win.closed) {
    saveGeometry(entry.geomKey, entry.win);
    try {
      entry.win.close();
    } catch {
      // já fechada
    }
  }
  entries.delete(id);
  emit();
}

/**
 * Abre (ou foca) a janela de uma transmissão.
 * `id`: identificador estável da transmissão (trackSid). `track`: MediaStreamTrack de vídeo recebida.
 * `geomKey`: chave para lembrar posição e tamanho. Devolve false se a janela não abriu.
 */
export function openStreamPopup({ id, track, title, geomKey }) {
  const existing = entries.get(id);
  if (existing && !existing.win.closed) {
    existing.win.focus();
    return true;
  }
  if (existing) cleanup(id);

  const saved = loadGeometry(geomKey);
  const offset = entries.size * 32; // janelas novas sem posição salva não ficam empilhadas
  const size = saved || { ...DEFAULT_SIZE, x: 80 + offset, y: 80 + offset };
  const features = `popup=yes,width=${size.width},height=${size.height},left=${size.x},top=${size.y}`;
  const win = window.open('about:blank', POPUP_PREFIX + id, features);
  if (!win) return false;

  const entry = { win, video: null, track, geomKey, fitted: false, timer: null };
  entries.set(id, entry);
  emit();

  // A janela do popup começa vazia; espera o documento ficar pronto para montar o vídeo.
  let attempts = 0;
  const ready = setInterval(() => {
    attempts += 1;
    try {
      if (win.closed) return clearInterval(ready);
      if (win.document?.body && win.document.readyState === 'complete') {
        clearInterval(ready);
        build(entry, title, entry.track);
      } else if (attempts > 100) {
        clearInterval(ready);
        cleanup(id);
      }
    } catch {
      clearInterval(ready);
      cleanup(id);
    }
  }, 30);

  // Acompanha o fechamento pelo "X" da janela e guarda a posição enquanto ela é movida.
  entry.timer = setInterval(() => {
    if (win.closed) cleanup(id);
    else saveGeometry(geomKey, win);
  }, 1000);
  return true;
}

/** Troca a faixa exibida (a transmissão foi reassinada e a MediaStreamTrack mudou). */
export function updatePopupTrack(id, track) {
  const entry = entries.get(id);
  if (!entry || entry.track === track) return;
  entry.track = track;
  if (entry.video) {
    entry.video.srcObject = new MediaStream([track]);
    entry.video.play().catch(() => {});
  }
}

export const closeStreamPopup = (id) => cleanup(id);
export const closeAllStreamPopups = () => [...entries.keys()].forEach(cleanup);

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', closeAllStreamPopups);
}
