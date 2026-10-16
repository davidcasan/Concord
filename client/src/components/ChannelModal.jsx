import { useState } from 'react';
import { Hash, Volume2 } from 'lucide-react';
import { emitAck } from '../api.js';
import Modal from './Modal.jsx';

/** Cria uma sala nova ou renomeia `channel`, se informado. */
export default function ChannelModal({ socket, channelType, channel, onClose, onCreated }) {
  const [type, setType] = useState(channel?.type || channelType || 'text');
  const [name, setName] = useState(channel?.name || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (channel) {
        await emitAck(socket, 'channel:rename', { id: channel.id, name });
      } else {
        const res = await emitAck(socket, 'channel:create', { name, type });
        onCreated(res.id);
      }
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={channel ? 'Renomear sala' : 'Criar sala'} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {!channel && (
          <div className="type-picker">
            <label className={type === 'text' ? 'selected' : ''}>
              <input type="radio" name="type" checked={type === 'text'} onChange={() => setType('text')} />
              <Hash size={22} />
              <div>
                <b>Texto</b>
                <small>Mensagens, links e imagens</small>
              </div>
            </label>
            <label className={type === 'voice' ? 'selected' : ''}>
              <input type="radio" name="type" checked={type === 'voice'} onChange={() => setType('voice')} />
              <Volume2 size={22} />
              <div>
                <b>Voz</b>
                <small>Voz, vídeo e compartilhamento de tela</small>
              </div>
            </label>
          </div>
        )}
        <label>
          Nome da sala
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus required placeholder={type === 'text' ? 'nova-sala' : 'Nova sala'} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-footer">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {channel ? 'Salvar' : 'Criar sala'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
