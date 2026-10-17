import { useEffect, useState } from 'react';
import { AppWindow, Monitor } from 'lucide-react';
import { SCREEN_QUALITIES } from '../settings.js';
import { MAX_SCREENS } from '../useVoice.js';
import Modal from './Modal.jsx';
import AudioSourceList from './AudioSourceList.jsx';

const desktop = typeof window !== 'undefined' ? window.minicordDesktop : undefined;

/**
 * Escolha do que compartilhar.
 * `mode="start"`: começa a transmissão, com até 2 telas/janelas e a fonte do áudio (única).
 * `mode="add"`: acrescenta mais uma tela a uma transmissão no ar (o áudio não muda); `taken` são os ids já em uso.
 */
export default function ScreenPicker({ settings, updateSettings, onClose, onPick, mode = 'start', taken = [] }) {
  const adding = mode === 'add';
  const slots = adding ? 1 : MAX_SCREENS;
  const [sources, setSources] = useState(null);
  const [tab, setTab] = useState('screen');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState([]); // fontes de vídeo escolhidas: [{ id, name }]
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
      {!desktop && !adding && (
        <label className="checkbox">
          <input type="checkbox" checked={settings.shareAudio} onChange={(e) => updateSettings({ shareAudio: e.target.checked })} />
          Compartilhar áudio do computador
        </label>
      )}
    </div>
  );

  if (!desktop) {
    return (
      <Modal title={adding ? 'Adicionar tela' : 'Compartilhar tela'} onClose={onClose}>
        <div className="modal-body">
          {options}
          <p className="muted small">
            O navegador vai abrir uma janela para escolher o que compartilhar{adding ? '' : ' (para duas telas, adicione a segunda depois)'}. Para enviar o som, escolha{' '}
            <b>Tela inteira</b> (ou uma aba do Chrome) e marque <b>Compartilhar áudio do sistema</b>. Pelo app desktop do Concord o áudio funciona com qualquer tela.
          </p>
          <div className="modal-footer">
            <button className="btn ghost" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn primary" onClick={() => onPick(adding ? { sources: [{}] } : { audio: settings.shareAudio })}>
              Escolher tela…
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  const list = (sources || []).filter((s) => (tab === 'screen' ? s.id.startsWith('screen:') : !s.id.startsWith('screen:')));
  const isSelected = (id) => selection.some((s) => s.id === id);

  const toggle = (s) => {
    setAudioChoice(null);
    setSelection((current) => {
      if (current.some((x) => x.id === s.id)) return current.filter((x) => x.id !== s.id);
      const next = [...current, { id: s.id, name: s.name }];
      return next.length > slots ? next.slice(next.length - slots) : next; // o mais antigo sai quando passa do limite
    });
  };

  const windowSources = selection.filter((s) => !s.id.startsWith('screen:'));
  const autoAudio = () => {
    if (settings.shareAudioMode === 'none') return { type: 'none' };
    if (settings.shareAudioMode === 'system' || !windowSources.length) return { type: 'system' };
    return { type: 'window', windowId: windowSources[0].id, name: windowSources[0].name };
  };
  const audio = audioChoice ?? autoAudio();

  const chooseAudio = (source) => {
    setAudioChoice(source);
    if (source.type === 'none' || source.type === 'system') updateSettings({ shareAudioMode: source.type });
    else if (source.type === 'window') updateSettings({ shareAudioMode: 'auto' });
  };

  const confirm = () => {
    const picked = selection.map((s) => ({ sourceId: s.id, sourceName: s.name }));
    onPick(adding ? { sources: picked } : { sources: picked, audio });
  };

  return (
    <Modal title={adding ? 'Adicionar tela à transmissão' : 'Compartilhar tela'} onClose={onClose} wide>
      <div className="modal-body">
        <div className="tabs">
          <button className={tab === 'screen' ? 'active' : ''} onClick={() => setTab('screen')}>
            <Monitor size={16} /> Telas
          </button>
          <button className={tab === 'window' ? 'active' : ''} onClick={() => setTab('window')}>
            <AppWindow size={16} /> Janelas
          </button>
        </div>
        {!adding && (
          <p className="muted small">
            Escolha até {MAX_SCREENS} telas ou janelas para transmitir ao mesmo tempo
            {selection.length ? ` (${selection.length} escolhida${selection.length > 1 ? 's' : ''})` : ''}.
          </p>
        )}
        {error && <div className="form-error">{error}</div>}
        {!sources && !error && <p className="muted">Carregando…</p>}
        <div className="source-grid">
          {list.map((s) => {
            const used = taken.includes(s.id);
            return (
              <button key={s.id} className={`source${isSelected(s.id) ? ' selected' : ''}`} disabled={used} onClick={() => toggle(s)}>
                <img src={s.thumbnail} alt="" />
                <span>
                  {s.appIcon && <img className="app-icon" src={s.appIcon} alt="" />}
                  {s.name}
                  {used && <small className="muted"> (já transmitindo)</small>}
                </span>
                {isSelected(s.id) && <span className="source-badge">{selection.findIndex((x) => x.id === s.id) + 1}</span>}
              </button>
            );
          })}
        </div>
        {!adding && <AudioSourceList value={audio} onChange={chooseAudio} windowSources={windowSources} />}
        {options}
        {!adding && (
          <p className="muted small">
            O áudio é único e independente das telas: você pode transmitir duas telas e levar só o som de um jogo, e trocar a fonte do áudio depois, com a
            transmissão no ar. O som do Concord (a voz dos seus amigos) nunca vai junto.
          </p>
        )}
        <div className="modal-footer">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!selection.length} onClick={confirm}>
            {adding ? 'Adicionar' : selection.length > 1 ? `Compartilhar ${selection.length} telas` : 'Compartilhar'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
