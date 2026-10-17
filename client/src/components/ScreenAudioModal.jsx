import Modal from './Modal.jsx';
import AudioSourceList from './AudioSourceList.jsx';

/** Troca a fonte do áudio com a transmissão já no ar; o vídeo não é interrompido. */
export default function ScreenAudioModal({ voice, updateSettings, onClose }) {
  const windowSource = voice.screenSource?.id.startsWith('window:') ? voice.screenSource : null;

  const choose = (source) => {
    if (source.type === 'none' || source.type === 'system') updateSettings({ shareAudioMode: source.type });
    else if (source.type === 'window') updateSettings({ shareAudioMode: 'auto' });
    void voice.setScreenAudio(source);
  };

  return (
    <Modal title="Áudio da transmissão" onClose={onClose}>
      <div className="modal-body">
        <AudioSourceList value={voice.screenAudio} onChange={choose} windowSource={windowSource} />
        <p className="muted small">A troca vale na hora, sem derrubar a transmissão de vídeo.</p>
        <div className="modal-footer">
          <button className="btn primary" onClick={onClose}>
            Pronto
          </button>
        </div>
      </div>
    </Modal>
  );
}
