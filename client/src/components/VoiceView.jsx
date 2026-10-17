import { useEffect, useRef, useState } from 'react';
import {
  AudioTrack,
  VideoTrack,
  isTrackReference,
  useAudioPlayback,
  useIsMuted,
  useIsSpeaking,
  useRoomContext,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import {
  AppWindow,
  Headphones,
  HeadphoneOff,
  Maximize,
  Mic,
  MicOff,
  PhoneOff,
  PictureInPicture2,
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import Avatar from './Avatar.jsx';
import { PopupAllButton, openScreenPopup } from './StreamPopups.jsx';
import { closeStreamPopup, popupsAvailable, useOpenPopupIds } from '../popups.js';
import { describeScreen, isScreenRef, screenSid } from '../screens.js';

/** Toca o áudio de todos os outros participantes (voz + áudio de tela), respeitando volume e "ensurdecer". */
export function VoiceAudio({ deafened, volumes }) {
  const tracks = useTracks([Track.Source.Microphone, Track.Source.ScreenShareAudio], { onlySubscribed: true });
  return (
    <div style={{ display: 'none' }}>
      {tracks
        .filter((t) => !t.participant.isLocal)
        .map((t) => {
          const key = t.source === Track.Source.ScreenShareAudio ? `${t.participant.identity}:screen` : t.participant.identity;
          return <AudioTrack key={t.publication.trackSid} trackRef={t} volume={volumes[key] ?? 1} muted={deafened} />;
        })}
    </div>
  );
}

export default function VoiceView({ channel, voice, members, users, volumes, notify, openVolumeMenu }) {
  const inThis = voice.channelId === channel.id;

  if (!inThis) {
    return (
      <div className="voice-view">
        <header className="main-header">
          <Volume2 size={22} className="muted" />
          <span className="title">{channel.name}</span>
        </header>
        <div className="voice-lobby">
          <h2>{channel.name}</h2>
          {members.length ? (
            <div className="lobby-members">
              {members.map((m) => (
                <Avatar key={m.userId} user={users[m.userId]} size={56} />
              ))}
            </div>
          ) : (
            <p className="muted">Ninguém está nesta sala ainda.</p>
          )}
          <button className="btn success" onClick={() => voice.join(channel.id)}>
            Entrar na sala de voz
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="voice-view">
      <header className="main-header">
        <Volume2 size={22} className="muted" />
        <span className="title">{channel.name}</span>
        {voice.status !== 'connected' && <span className="muted small">{voice.status === 'reconnecting' ? 'Reconectando…' : 'Conectando…'}</span>}
      </header>
      {voice.status === 'connecting' ? <div className="voice-lobby muted">Conectando…</div> : <Stage users={users} volumes={volumes} voice={voice} notify={notify} openVolumeMenu={openVolumeMenu} />}
      <AudioUnlock />
      <div className="voice-controls">
        <button className={`round-btn${voice.muted || voice.deafened ? ' off' : ''}`} title={voice.muted ? 'Desmutar' : 'Mutar'} onClick={voice.toggleMute}>
          {voice.muted || voice.deafened ? <MicOff /> : <Mic />}
        </button>
        <button className={`round-btn${voice.deafened ? ' off' : ''}`} title={voice.deafened ? 'Voltar a ouvir' : 'Ensurdecer'} onClick={voice.toggleDeafen}>
          {voice.deafened ? <HeadphoneOff /> : <Headphones />}
        </button>
        <button className={`round-btn${voice.camera ? ' on' : ''}`} title={voice.camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={voice.toggleCamera}>
          {voice.camera ? <Video /> : <VideoOff />}
        </button>
        <button className={`round-btn${voice.screen ? ' on' : ''}`} title={voice.screen ? 'Parar de compartilhar' : 'Compartilhar tela'} onClick={voice.openScreenShare}>
          {voice.screen ? <ScreenShareOff /> : <ScreenShare />}
        </button>
        <PopupAllButton users={users} />
        <button className="round-btn danger" title="Desconectar" onClick={() => voice.leave()}>
          <PhoneOff />
        </button>
      </div>
    </div>
  );
}

function AudioUnlock() {
  const room = useRoomContext();
  const { canPlayAudio, startAudio } = useAudioPlayback(room);
  if (canPlayAudio) return null;
  return (
    <button className="audio-unlock" onClick={startAudio}>
      O navegador bloqueou o áudio. Clique aqui para ouvir a sala.
    </button>
  );
}

// Uma pessoa pode ter até duas telas: o id da transmissão separa uma da outra.
const keyOf = (t) =>
  isScreenRef(t) && screenSid(t) ? `${t.participant.identity}:${t.source}:${screenSid(t)}` : `${t.participant.identity}:${t.source}`;

function Stage({ users, volumes, voice, notify, openVolumeMenu }) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const [focus, setFocus] = useState(null);
  const allScreens = tracks.filter(isScreenRef);
  const remoteScreens = allScreens.filter((t) => !t.participant.isLocal);
  const openIds = useOpenPopupIds();
  const lastScreens = useRef(new Set());
  const remoteScreenKeys = remoteScreens.map(keyOf).join('|');

  // Quando alguém começa a compartilhar a tela, ela vai para o destaque automaticamente.
  useEffect(() => {
    const started = remoteScreens.find((track) => !lastScreens.current.has(keyOf(track)));
    if (started) setFocus(keyOf(started));
    lastScreens.current = new Set(remoteScreens.map(keyOf));
  }, [remoteScreenKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const focused = focus && tracks.find((t) => keyOf(t) === focus);
  const toggleFocus = (t) => setFocus((f) => (f === keyOf(t) ? null : keyOf(t)));

  const tile = (t, extra = '') => (
    <Tile
      key={keyOf(t)}
      trackRef={t}
      user={users[t.participant.identity]}
      className={extra}
      screens={allScreens}
      remoteScreens={remoteScreens}
      popupOpen={openIds.has(screenSid(t))}
      onClick={() => toggleFocus(t)}
      volumes={volumes}
      setVolume={voice.setVolume}
      notify={notify}
      openVolumeMenu={openVolumeMenu}
    />
  );

  if (focused) {
    return (
      <div className="stage focus">
        <div className="stage-main">{tile(focused, 'big')}</div>
        <div className="stage-strip">{tracks.filter((t) => t !== focused).map((t) => tile(t, 'small'))}</div>
      </div>
    );
  }

  const cols = tracks.length <= 1 ? 1 : tracks.length <= 4 ? 2 : 3;
  return (
    <div className="stage grid" style={{ '--cols': cols }}>
      {tracks.map((t) => tile(t))}
    </div>
  );
}

function Tile({ trackRef, user, className = '', screens = [], remoteScreens = [], popupOpen = false, onClick, volumes, setVolume, notify, openVolumeMenu }) {
  const ref = useRef(null);
  const participant = trackRef.participant;
  const isScreen = trackRef.source === Track.Source.ScreenShare;
  const speaking = useIsSpeaking(participant);
  const videoMuted = useIsMuted(trackRef);
  const micMuted = useIsMuted({ participant, source: Track.Source.Microphone });
  const [showVolume, setShowVolume] = useState(false);
  const hasVideo = isTrackReference(trackRef) && !videoMuted;
  const volumeKey = isScreen ? `${participant.identity}:screen` : participant.identity;
  const volume = volumes?.[volumeKey] ?? 1;
  const name = user?.displayName || participant.name || '…';

  const fullscreen = (e) => {
    e.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen();
    else ref.current?.requestFullscreen();
  };

  const popOut = async (e) => {
    e.stopPropagation();
    if (popupsAvailable()) {
      // App desktop: uma janela própria por transmissão (várias ao mesmo tempo).
      if (popupOpen) closeStreamPopup(screenSid(trackRef));
      else if (!openScreenPopup(trackRef, remoteScreens, { [participant.identity]: user })) notify('Não foi possível abrir a janela da transmissão.');
      return;
    }
    const video = ref.current?.querySelector('video');
    if (!document.pictureInPictureEnabled || !video?.requestPictureInPicture) {
      notify('A janela flutuante de vídeo não é compatível com este ambiente.');
      return;
    }
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        await video.requestPictureInPicture();
      }
    } catch (error) {
      notify(`Não foi possível abrir a transmissão em janela flutuante: ${error.message}`);
    }
  };

  const showVolumeMenu = (event) => {
    if (participant.isLocal) return;
    openVolumeMenu(event, volumeKey, name, isScreen ? 'screen' : 'mic');
  };

  return (
    <div
      ref={ref}
      className={`tile ${className}${speaking && !isScreen && !micMuted ? ' speaking' : ''}${isScreen ? ' screen' : ''}`}
      onClick={onClick}
      onContextMenu={showVolumeMenu}
    >
      {isScreen && popupOpen ? (
        // Em janela flutuante o vídeo não é desenhado aqui (poupa processador e placa de vídeo).
        // A transmissão continua assinada pelo StreamPopups, então a janela segue tocando.
        <div className="tile-popped">
          <AppWindow size={28} />
          <span>Em janela flutuante</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              closeStreamPopup(screenSid(trackRef));
            }}
          >
            Trazer de volta
          </button>
        </div>
      ) : hasVideo ? (
        <VideoTrack trackRef={trackRef} className={participant.isLocal && !isScreen ? 'mirror' : ''} style={{ objectFit: isScreen ? 'contain' : 'cover' }} />
      ) : (
        <div className="tile-avatar">
          <Avatar user={user} size={className === 'small' ? 48 : 80} speaking={speaking && !micMuted} />
        </div>
      )}

      <div className="tile-label">
        {!isScreen && micMuted && <MicOff size={14} className="red" />}
        {isScreen && <ScreenShare size={14} />}
        <span>{isScreen ? describeScreen(trackRef, screens, { [participant.identity]: user }).label : name}</span>
      </div>

      <div className="tile-actions" onClick={(e) => e.stopPropagation()}>
        {isScreen && hasVideo && !participant.isLocal && (
          <button
            className={popupOpen ? 'on' : ''}
            title={popupOpen ? 'Fechar a janela desta transmissão' : 'Abrir transmissão em janela flutuante'}
            aria-label="Abrir transmissão em janela flutuante"
            onClick={popOut}
          >
            <PictureInPicture2 size={16} />
          </button>
        )}
        {!participant.isLocal && (
          <div className="tile-volume">
            <button title="Volume" onClick={() => setShowVolume((v) => !v)}>
              {volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            {showVolume && (
              <div className="volume-pop">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(volume * 100)}
                  onChange={(e) => setVolume(volumeKey, Number(e.target.value) / 100)}
                />
                <span>{Math.round(volume * 100)}%</span>
              </div>
            )}
          </div>
        )}
        {hasVideo && !(isScreen && popupOpen) && (
          <button title="Tela cheia" onClick={fullscreen}>
            <Maximize size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
