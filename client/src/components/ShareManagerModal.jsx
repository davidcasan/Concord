import { MonitorUp, Plus, X } from 'lucide-react';
import { MAX_SCREENS } from '../useVoice.js';
import Modal from './Modal.jsx';
import AudioSourceList from './AudioSourceList.jsx';

const desktop = typeof window !== 'undefined' ? window.minicordDesktop : undefined;

/** Gerencia a transmissão no ar: quais telas estão sendo enviadas e de onde vem o áudio (único). */
export default function ShareManagerModal({ voice, updateSettings, onAddScreen, onClose }) {
  const windowSources = voice.screens.filter((s) => s.sourceId?.startsWith('window:')).map((s) => ({ id: s.sourceId, name: s.name }));

  const chooseAudio = (source) => {
    if (source.type === 'none' || source.type === 'system') updateSettings({ shareAudioMode: source.type });
    else if (source.type === 'window') updateSettings({ shareAudioMode: 'auto' });
    void voice.setScreenAudio(source);
  };

  return (
    <Modal title="Transmissão" onClose={onClose}>
      <div className="modal-body">
        <div className="audio-sources-head">
          <span className="field-label">
            Telas ({voice.screens.length}/{MAX_SCREENS})
          </span>
        </div>
        <div className="audio-source-list">
          {voice.screens.map((s, i) => (
            <div key={s.sid} className="audio-source selected">
              <MonitorUp size={18} />
              <span className="audio-source-name">{s.name || `Tela ${i + 1}`}</span>
              <button type="button" className="btn ghost small-btn" onClick={() => voice.removeScreen(s.sid)}>
                <X size={14} /> {voice.screens.length === 1 ? 'Encerrar' : 'Parar'}
              </button>
            </div>
          ))}
        </div>
        {voice.screens.length < MAX_SCREENS && (
          <button type="button" className="btn ghost" onClick={onAddScreen}>
            <Plus size={14} /> Adicionar outra tela
          </button>
        )}

        {desktop?.listAudioApps && (
          <>
            <hr />
            <AudioSourceList value={voice.screenAudio} onChange={chooseAudio} windowSources={windowSources} />
            <p className="muted small">A troca do áudio vale na hora, sem derrubar as telas.</p>
          </>
        )}

        <div className="modal-footer">
          <button className="btn primary" onClick={onClose}>
            Pronto
          </button>
        </div>
      </div>
    </Modal>
  );
}
