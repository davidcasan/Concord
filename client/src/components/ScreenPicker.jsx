import { useEffect, useState } from 'react';
import { AppWindow, Monitor } from 'lucide-react';
import { SCREEN_QUALITIES } from '../settings.js';
import Modal from './Modal.jsx';

const desktop = typeof window !== 'undefined' ? window.minicordDesktop : undefined;

export default function ScreenPicker({ settings, updateSettings, onClose, onPick }) {
  const [sources, setSources] = useState(null);
  const [tab, setTab] = useState('screen');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!desktop) return;
    desktop
      .getSources()
      .then(setSources)
      .catch((err) => setError(err.message));
  }, []);

  const options = (
    <div className="share-options">
      <label>
        Qualidade
        <select value={settings.screenQuality} onChange={(e) => updateSettings({ screenQuality: e.target.value })}>
          {Object.entries(SCREEN_QUALITIES).map(([k, q]) => (
            <option key={k} value={k}>
              {q.label}
            </option>
          ))}
        </select>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={settings.shareAudio} onChange={(e) => updateSettings({ shareAudio: e.target.checked })} />
        Compartilhar áudio do computador
      </label>
    </div>
  );

  if (!desktop) {
    return (
      <Modal title="Compartilhar tela" onClose={onClose}>
        <div className="modal-body">
          {options}
          <p className="muted small">
            O navegador vai abrir uma janela para escolher o que compartilhar. Para enviar o som, escolha <b>Tela inteira</b> (ou uma aba do Chrome) e
            marque <b>Compartilhar áudio do sistema</b>. Pelo app desktop do Concord o áudio funciona com qualquer tela.
          </p>
          <div className="modal-footer">
            <button className="btn ghost" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn primary" onClick={() => onPick({ audio: settings.shareAudio })}>
              Escolher tela…
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const list = (sources || []).filter((s) => (tab === 'screen' ? s.id.startsWith('screen:') : !s.id.startsWith('screen:')));

  return (
    <Modal title="Compartilhar tela" onClose={onClose} wide>
      <div className="modal-body">
        <div className="tabs">
          <button className={tab === 'screen' ? 'active' : ''} onClick={() => setTab('screen')}>
            <Monitor size={16} /> Telas
          </button>
          <button className={tab === 'window' ? 'active' : ''} onClick={() => setTab('window')}>
            <AppWindow size={16} /> Janelas
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
        {!sources && !error && <p className="muted">Carregando…</p>}
        <div className="source-grid">
          {list.map((s) => (
            <button key={s.id} className="source" onClick={() => onPick({ sourceId: s.id, audio: settings.shareAudio })}>
              <img src={s.thumbnail} alt="" />
              <span>
                {s.appIcon && <img className="app-icon" src={s.appIcon} alt="" />}
                {s.name}
              </span>
            </button>
          ))}
        </div>
        {options}
        {settings.shareAudio && (
          <p className="muted small">O som do Concord (a voz dos seus amigos) fica de fora automaticamente, então ninguém se ouve de volta.</p>
        )}
      </div>
    </Modal>
  );
}
