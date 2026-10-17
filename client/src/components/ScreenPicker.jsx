import { useEffect, useState } from 'react';
import { AppWindow, Monitor } from 'lucide-react';
import { SCREEN_QUALITIES } from '../settings.js';
import Modal from './Modal.jsx';
import AudioSourceList from './AudioSourceList.jsx';

const desktop = typeof window !== 'undefined' ? window.minicordDesktop : undefined;

export default function ScreenPicker({ settings, updateSettings, onClose, onPick }) {
  const [sources, setSources] = useState(null);
  const [tab, setTab] = useState('screen');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // fonte de vídeo escolhida
  const [audioChoice, setAudioChoice] = useState(null); // null = automático

  useEffect(() => {
    if (!desktop) return;
    desktop
      .getSources()
      .then(setSources)
      .catch((err) => setError(err.message));
  }, []);

  const qualityOption = (
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
  );
  const options = (
    <div className="share-options">
      {qualityOption}
      {!desktop && (
        <label className="checkbox">
          <input type="checkbox" checked={settings.shareAudio} onChange={(e) => updateSettings({ shareAudio: e.target.checked })} />
          Compartilhar áudio do computador
        </label>
      )}
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

  const windowSource = selected && !selected.id.startsWith('screen:') ? selected : null;
  const autoAudio = () => {
    if (settings.shareAudioMode === 'none') return { type: 'none' };
    if (settings.shareAudioMode === 'system' || !windowSource) return { type: 'system' };
    return { type: 'window', windowId: windowSource.id, name: windowSource.name };
  };
  const audio = audioChoice ?? autoAudio();

  const chooseAudio = (source) => {
    setAudioChoice(source);
    if (source.type === 'none' || source.type === 'system') updateSettings({ shareAudioMode: source.type });
    else if (source.type === 'window') updateSettings({ shareAudioMode: 'auto' });
  };

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
            <button
              key={s.id}
              className={`source${selected?.id === s.id ? ' selected' : ''}`}
              onClick={() => {
                setSelected({ id: s.id, name: s.name });
                setAudioChoice(null);
              }}
            >
              <img src={s.thumbnail} alt="" />
              <span>
                {s.appIcon && <img className="app-icon" src={s.appIcon} alt="" />}
                {s.name}
              </span>
            </button>
          ))}
        </div>
        <AudioSourceList value={audio} onChange={chooseAudio} windowSource={windowSource} />
        {options}
        <p className="muted small">
          O vídeo e o áudio são independentes: você pode transmitir uma tela e levar só o som de um jogo, e trocar a fonte do áudio depois, com a
          transmissão no ar. O som do Concord (a voz dos seus amigos) nunca vai junto.
        </p>
        <div className="modal-footer">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn primary"
            disabled={!selected}
            onClick={() => onPick({ sourceId: selected.id, sourceName: selected.name, audio })}
          >
            Compartilhar
          </button>
        </div>
      </div>
    </Modal>
  );
}
