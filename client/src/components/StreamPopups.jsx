import { useEffect, useRef } from 'react';
import { VideoTrack, isTrackReference, useTracks } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { AppWindow } from 'lucide-react';
import { closeAllStreamPopups, closeStreamPopup, openStreamPopup, popupsAvailable, updatePopupTrack, useOpenPopupIds } from '../popups.js';
import { describeScreen, screenSid } from '../screens.js';

const SCREEN_QUERY = [{ source: Track.Source.ScreenShare, withPlaceholder: false }];

/** Todas as telas compartilhadas por outras pessoas (inclusive as ainda não assinadas). */
export function useRemoteScreens() {
  const tracks = useTracks(SCREEN_QUERY, { onlySubscribed: false });
  return tracks.filter((t) => !t.participant.isLocal && isTrackReference(t));
}

const videoTrackOf = (t) => t.publication?.track?.mediaStreamTrack;

/** Abre a janela flutuante de uma tela. Devolve false se ainda não há vídeo ou a janela não abriu. */
export function openScreenPopup(t, screens, users) {
  const track = videoTrackOf(t);
  if (!track) return false;
  const { title, geomKey } = describeScreen(t, screens, users);
  return openStreamPopup({ id: screenSid(t), track, title, geomKey });
}

/**
 * Fica sempre montado (fora da tela de voz), para os popups continuarem vivos ao navegar pelo app.
 * - fecha o popup quando a transmissão acaba e atualiza a faixa se ela for reassinada;
 * - abre as transmissões novas sozinho, se a opção estiver ligada;
 * - mantém um vídeo minúsculo ligado no LiveKit: sem elemento visível ele pausaria a transmissão.
 */
export function StreamPopups({ voice, users, autoOpen }) {
  const remote = useRemoteScreens();
  const openIds = useOpenPopupIds();
  const seen = useRef(new Set());
  const signature = remote.map((t) => `${screenSid(t)}:${videoTrackOf(t)?.id || ''}`).join('|');

  useEffect(() => {
    for (const id of openIds) {
      const t = remote.find((r) => screenSid(r) === id);
      const track = t && videoTrackOf(t);
      if (!track) closeStreamPopup(id);
      else updatePopupTrack(id, track);
    }
    if (!popupsAvailable()) return;
    for (const t of remote) {
      const sid = screenSid(t);
      if (!videoTrackOf(t) || seen.current.has(sid)) continue;
      seen.current.add(sid); // quem fechou a janela de propósito não a vê voltar
      if (autoOpen) openScreenPopup(t, remote, users);
    }
  }, [signature, openIds]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (voice.channelId) return;
    closeAllStreamPopups();
    seen.current.clear();
  }, [voice.channelId]);

  return (
    <div className="popup-keepalive" aria-hidden="true">
      {remote
        .filter((t) => openIds.has(screenSid(t)) && videoTrackOf(t))
        .map((t) => (
          <VideoTrack key={screenSid(t)} trackRef={t} />
        ))}
    </div>
  );
}

/** Botão da barra de voz: abre (ou fecha) todas as transmissões em janelas flutuantes. */
export function PopupAllButton({ users }) {
  const remote = useRemoteScreens();
  const openIds = useOpenPopupIds();
  const playable = remote.filter(videoTrackOf);
  if (!popupsAvailable() || playable.length === 0) return null;
  const allOpen = playable.every((t) => openIds.has(screenSid(t)));
  const toggle = () => {
    if (allOpen) playable.forEach((t) => closeStreamPopup(screenSid(t)));
    else playable.forEach((t) => openScreenPopup(t, remote, users));
  };
  return (
    <button
      className={`round-btn${allOpen ? ' on' : ''}`}
      title={allOpen ? 'Fechar janelas das transmissões' : 'Abrir todas as transmissões em janelas'}
      onClick={toggle}
    >
      <AppWindow />
    </button>
  );
}
