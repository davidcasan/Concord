import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Mic, Volume2, VolumeX } from 'lucide-react';

export default function VolumeContextMenu({ menu, volume, onVolumeChange, onToggleMute, onClose }) {
  const ref = useRef(null);
  const isMuted = volume === 0;
  const sourceLabel = menu.source === 'screen' ? 'áudio da transmissão' : 'microfone';
  const label = `${sourceLabel} de ${menu.name}`;

  useEffect(() => {
    const onPointerDown = (event) => {
      if (!ref.current?.contains(event.target)) onClose();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="volume-context-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      aria-label={`Controles de ${label}`}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="volume-context-title" title={label}>
        {menu.source === 'screen' ? <Volume2 size={15} /> : <Mic size={15} />}
        <span>{label}</span>
      </div>
      <button type="button" role="menuitem" onClick={onToggleMute}>
        {isMuted ? <Volume2 size={15} /> : <VolumeX size={15} />}
        {isMuted ? 'Ativar som' : 'Mutar'}
      </button>
      <label className="volume-context-slider">
        <span>Volume</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(volume * 100)}
          aria-label={`Volume: ${Math.round(volume * 100)}%`}
          onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
        />
        <span>{Math.round(volume * 100)}%</span>
      </label>
    </div>,
    document.body,
  );
}
