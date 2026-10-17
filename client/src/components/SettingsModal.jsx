import { useEffect, useRef, useState } from 'react';
import { api, uploadAvatar } from '../api.js';
import { prepareAvatar } from '../avatar.js';
import Avatar from './Avatar.jsx';
import { createMicAudioProcessor } from '../audio/micProcessor.js';
import { RNNOISE_SAMPLE_RATE } from '../audio/rnnoise.js';
import Modal from './Modal.jsx';

const COLORS = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#f47b67', '#3ba55c', '#faa61a', '#9b59b6', '#1abc9c', '#e67e22', '#95a5a6'];

export default function SettingsModal({ me, settings, updateSettings, voice, onLogout, notify, onClose }) {
  const [tab, setTab] = useState('account');
  return (
    <Modal title="Configurações" onClose={onClose} wide>
      <div className="settings">
        <nav className="settings-nav">
          <button className={tab === 'account' ? 'active' : ''} onClick={() => setTab('account')}>
            Minha conta
          </button>
          <button className={tab === 'voice' ? 'active' : ''} onClick={() => setTab('voice')}>
            Voz e vídeo
          </button>
          <button className={tab === 'app' ? 'active' : ''} onClick={() => setTab('app')}>
            Notificações
          </button>
          <hr />
          <button className="danger-text" onClick={onLogout}>
            Sair da conta
          </button>
        </nav>
        <div className="settings-content">
          {tab === 'account' && <AccountTab me={me} notify={notify} />}
          {tab === 'voice' && <VoiceTab settings={settings} updateSettings={updateSettings} voice={voice} notify={notify} />}
          {tab === 'app' && (
            <section>
              <h3>Notificações</h3>
              <Toggle label="Sons (entrar/sair, mutar, novas mensagens)" checked={settings.sounds} onChange={(v) => updateSettings({ sounds: v })} />
              {window.minicordDesktop?.isDesktop && (
                <Toggle
                  label="Abrir transmissões em janelas flutuantes"
                  hint="Quando alguém compartilhar a tela, ela abre sozinha numa janela sempre no topo (cada tela numa janela)."
                  checked={!!settings.autoPopup}
                  onChange={(v) => updateSettings({ autoPopup: v })}
                />
              )}
            </section>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <label className="toggle">
      <div>
        <div>{label}</div>
        {hint && <small className="muted">{hint}</small>}
      </div>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function AccountTab({ me, notify }) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [color, setColor] = useState(me.color);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [pwError, setPwError] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const fileInput = useRef(null);

  async function choosePhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite escolher o mesmo arquivo de novo
    if (!file) return;
    setPhotoError('');
    setPhotoBusy(true);
    try {
      await uploadAvatar(await prepareAvatar(file));
      notify('Foto de perfil atualizada.');
    } catch (err) {
      setPhotoError(err.message);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removePhoto() {
    setPhotoError('');
    setPhotoBusy(true);
    try {
      await api('/me/avatar', { method: 'DELETE' });
      notify('Foto de perfil removida.');
    } catch (err) {
      setPhotoError(err.message);
    } finally {
      setPhotoBusy(false);
    }
  }

  async function saveProfile(e) {
    e.preventDefault();
    setError('');
    try {
      await api('/me', { method: 'PATCH', body: { displayName, color } });
      notify('Perfil atualizado.');
    } catch (err) {
      setError(err.message);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    setPwError('');
    try {
      await api('/me/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      notify('Senha alterada. Outras sessões foram desconectadas.');
    } catch (err) {
      setPwError(err.message);
    }
  }

  return (
    <>
      <section>
        <h3>Foto de perfil</h3>
        <div className="avatar-edit">
          <Avatar user={me} size={80} />
          <div>
            <div className="avatar-edit-buttons">
              <button type="button" className="btn primary" disabled={photoBusy} onClick={() => fileInput.current?.click()}>
                {photoBusy ? 'Enviando…' : 'Enviar foto'}
              </button>
              {me.avatar && (
                <button type="button" className="btn ghost" disabled={photoBusy} onClick={removePhoto}>
                  Remover foto
                </button>
              )}
            </div>
            <p className="muted small">PNG, JPG, WebP ou GIF, até 10 MB. A imagem é recortada em quadrado.</p>
          </div>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={choosePhoto} />
        </div>
        {photoError && <div className="form-error">{photoError}</div>}
      </section>

      <form onSubmit={saveProfile}>
        <h3>Perfil</h3>
        <label>
          Nome de exibição
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
        </label>
        <div className="field-label">Cor</div>
        <div className="color-row">
          {COLORS.map((c) => (
            <button type="button" key={c} className={`color-swatch${c === color ? ' selected' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
        <p className="muted small">Usuário de login: @{me.username}</p>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary">Salvar perfil</button>
      </form>

      <form onSubmit={changePassword}>
        <h3>Trocar senha</h3>
        <label>
          Senha atual
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          Nova senha
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={6} />
        </label>
        {pwError && <div className="form-error">{pwError}</div>}
        <button className="btn primary">Trocar senha</button>
      </form>
    </>
  );
}

function VoiceTab({ settings, updateSettings, voice, notify }) {
  const [devices, setDevices] = useState([]);

  const refresh = () =>
    navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => {});

  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, []);

  const needsPermission = devices.length > 0 && devices.every((d) => !d.label);
  const askPermission = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
      s.getTracks().forEach((t) => t.stop());
    } finally {
      refresh();
    }
  };

  const select = (kind, label, value) => {
    const list = devices.filter((d) => d.kind === kind && d.deviceId);
    return (
      <label>
        {label}
        <select value={value} onChange={(e) => voice.setDevice(kind, e.target.value)}>
          <option value="">Padrão do sistema</option>
          {list.map((d, i) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Dispositivo ${i + 1}`}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const setProcessing = (patch) => {
    updateSettings(patch);
    setTimeout(voice.restartMic, 0);
  };

  const setMicProcessing = (patch) => {
    updateSettings(patch);
    void voice.updateMicProcessing({ ...settings, ...patch });
  };

  return (
    <>
      <section>
        <h3>Dispositivos</h3>
        {needsPermission && (
          <button className="btn ghost" onClick={askPermission}>
            Permitir acesso ao microfone e câmera para ver os nomes dos dispositivos
          </button>
        )}
        {select('audioinput', 'Microfone', settings.micId)}
        {select('audiooutput', 'Saída de áudio', settings.outId)}
        {select('videoinput', 'Câmera', settings.camId)}
        <MicTest settings={settings} notify={notify} />
      </section>
      <section>
        <h3>Processamento de voz</h3>
        <label className="settings-range">
          Sensibilidade do microfone
          <span className="range-value">{settings.micSensitivity}%</span>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={settings.micSensitivity}
            onChange={(event) => setMicProcessing({ micSensitivity: Number(event.target.value) })}
          />
          <small className="muted">Ajusta o ganho do microfone antes de enviar sua voz.</small>
        </label>
        <Toggle
          label="Gate de ruído do microfone"
          hint="Reduz o sinal quando o nível do microfone fica abaixo do corte."
          checked={settings.micGateEnabled}
          onChange={(v) => setMicProcessing({ micGateEnabled: v })}
        />
        <label className={`settings-range${settings.micGateEnabled ? '' : ' disabled'}`}>
          Corte do gate
          <span className="range-value">{settings.micGateCut} dB</span>
          <input
            type="range"
            min={-60}
            max={-20}
            step={1}
            value={settings.micGateCut}
            disabled={!settings.micGateEnabled}
            onChange={(event) => setMicProcessing({ micGateCut: Number(event.target.value) })}
          />
          <small className="muted">O áudio abaixo desse nível é atenuado. Um corte mais baixo preserva sons mais suaves.</small>
        </label>
        <label>
          Redução de ruído
          <select value={settings.noiseEngine} onChange={(e) => setProcessing({ noiseEngine: e.target.value })}>
            <option value="rnnoise">Avançada (RNNoise, local)</option>
            <option value="browser">Padrão (filtro do navegador)</option>
            <option value="off">Desligada</option>
          </select>
          <small className="muted">
            A avançada usa uma rede neural que roda no seu computador e remove teclado, ventilador e outros ruídos de fundo. Nada sai da sua máquina.
          </small>
        </label>
        <Toggle
          label="Cancelamento de eco"
          hint="Desligue se estiver usando fone e quiser mais qualidade."
          checked={settings.echoCancellation}
          onChange={(v) => setProcessing({ echoCancellation: v })}
        />
        <Toggle
          label="Ganho automático"
          hint="Ajusta o volume do microfone sozinho."
          checked={settings.autoGainControl}
          onChange={(v) => setProcessing({ autoGainControl: v })}
        />
      </section>
    </>
  );
}

function MicTest({ settings, notify }) {
  const [level, setLevel] = useState(null);
  const stop = useRef(null);

  useEffect(() => () => stop.current?.(), []);

  async function toggle() {
    if (stop.current) {
      stop.current();
      stop.current = null;
      setLevel(null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.micId || undefined,
          noiseSuppression: settings.noiseEngine === 'browser',
          echoCancellation: settings.echoCancellation,
          autoGainControl: settings.autoGainControl,
        },
      });
      let ctx;
      const processor = createMicAudioProcessor(settings);
      try {
        ctx = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE });
        await ctx.resume();
        await processor.init({ track: stream.getAudioTracks()[0], audioContext: ctx });
        if (processor.noiseError) notify(`Não foi possível ligar a redução de ruído: ${processor.noiseError.message}`);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(new MediaStream([processor.processedTrack])).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        let raf;
        const loop = () => {
          analyser.getFloatTimeDomainData(data);
          const rms = Math.sqrt(data.reduce((s, x) => s + x * x, 0) / data.length);
          setLevel(Math.min(1, rms * 4));
          raf = requestAnimationFrame(loop);
        };
        loop();
        stop.current = () => {
          cancelAnimationFrame(raf);
          void processor.destroy();
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close();
        };
      } catch (error) {
        await processor.destroy();
        stream.getTracks().forEach((track) => track.stop());
        if (ctx && ctx.state !== 'closed') await ctx.close();
        throw error;
      }
    } catch (error) {
      setLevel(null);
      notify(`Não foi possível testar o microfone: ${error.message}`);
    }
  }

  return (
    <div className="mic-test">
      <button type="button" className="btn ghost" onClick={toggle}>
        {level === null ? 'Testar microfone' : 'Parar teste'}
      </button>
      <div className="meter">
        <div style={{ width: `${(level || 0) * 100}%` }} />
      </div>
    </div>
  );
}
