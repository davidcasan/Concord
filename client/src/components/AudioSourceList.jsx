import { useCallback, useEffect, useState } from 'react';
import { AppWindow, Monitor, RefreshCw, VolumeX } from 'lucide-react';

const desktop = typeof window !== 'undefined' ? window.minicordDesktop : undefined;

const sameSource = (a, b) =>
  !!a && !!b && a.type === b.type && (a.type === 'app' ? a.pid === b.pid : a.type === 'window' ? a.windowId === b.windowId : true);

/**
 * Lista de fontes de áudio da transmissão (app desktop): nenhuma, todo o computador,
 * o aplicativo da janela compartilhada ou qualquer aplicativo com áudio aberto.
 * `windowSources`: [{ id, name }] das janelas (não telas) que estão sendo compartilhadas.
 */
export default function AudioSourceList({ value, onChange, windowSources = [] }) {
  const [apps, setApps] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    setError('');
    desktop
      ?.listAudioApps()
      .then(setApps)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(refresh, [refresh]);

  const rows = [
    { source: { type: 'none' }, label: 'Sem áudio', icon: <VolumeX size={18} /> },
    { source: { type: 'system' }, label: 'Todo o áudio do computador', hint: 'Sem a voz dos seus amigos', icon: <Monitor size={18} /> },
  ];
  for (const windowSource of windowSources) {
    rows.push({
      source: { type: 'window', windowId: windowSource.id, name: windowSource.name },
      label: `Janela compartilhada: ${windowSource.name}`,
      hint: 'Só o áudio do aplicativo dessa janela',
      icon: <AppWindow size={18} />,
    });
  }
  const list = apps ? [...apps] : [];
  if (value?.type === 'app' && !list.some((a) => a.pid === value.pid)) list.unshift({ pid: value.pid, name: value.name, active: false });
  for (const a of list) {
    rows.push({
      source: { type: 'app', pid: a.pid, name: a.name },
      label: a.name,
      hint: a.active ? 'Tocando agora' : undefined,
      icon: a.icon ? <img className="app-icon" src={a.icon} alt="" /> : <AppWindow size={18} />,
    });
  }

  return (
    <div className="audio-sources">
      <div className="audio-sources-head">
        <span className="field-label">Fonte do áudio</span>
        <button type="button" className="icon-btn" title="Atualizar lista de aplicativos" onClick={refresh}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="audio-source-list" role="radiogroup">
        {rows.map((row) => (
          <button
            type="button"
            role="radio"
            aria-checked={sameSource(value, row.source)}
            key={`${row.source.type}:${row.source.pid ?? row.source.windowId ?? ''}`}
            className={`audio-source${sameSource(value, row.source) ? ' selected' : ''}`}
            onClick={() => onChange(row.source)}
          >
            {row.icon}
            <span className="audio-source-name">{row.label}</span>
            {row.hint && <small className="muted">{row.hint}</small>}
          </button>
        ))}
      </div>
      {error && <p className="muted small">Não foi possível listar os aplicativos: {error}</p>}
      {!apps && !error && <p className="muted small">Procurando aplicativos com áudio…</p>}
      {apps && apps.length === 0 && <p className="muted small">Nenhum aplicativo com áudio aberto agora. Abra o jogo ou o navegador e atualize a lista.</p>}
    </div>
  );
}
