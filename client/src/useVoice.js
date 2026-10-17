import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioPresets, Room, RoomEvent, Track, VideoPresets } from 'livekit-client';
import { api } from './api.js';
import { sounds } from './sounds.js';
import { SCREEN_QUALITIES } from './settings.js';
import { createSystemAudioTrack, nativeSystemAudioAvailable } from './systemAudio.js';
import { createMicAudioProcessor } from './audio/micProcessor.js';

const SCREEN_AUDIO_PUBLISH = {
  source: Track.Source.ScreenShareAudio,
  audioPreset: AudioPresets.musicHighQualityStereo,
  forceStereo: true,
  dtx: false,
  red: false,
};

/**
 * Gerencia a conexão de voz (uma sala por vez), como no Discord:
 * dá para continuar conectado na voz enquanto navega pelas salas de texto.
 */
export function useVoice({ socket, settings, updateSettings, notify }) {
  const room = useMemo(() => new Room({ adaptiveStream: true, dynacast: true }), []);
  const [channelId, setChannelId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | connecting | connected | reconnecting
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);

  const screenTracks = useRef([]);
  const systemAudio = useRef(null);
  const micAudioContext = useRef(null);
  const leaving = useRef(false);
  const state = useRef({});
  state.current = { channelId, muted, deafened, camera, screen };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const play = useCallback((name) => settingsRef.current.sounds && sounds[name](), []);
  const emit = useCallback((patch) => socket?.emit('voice:update', patch), [socket]);

  const micOptions = () => {
    const s = settingsRef.current;
    return {
      deviceId: s.micId || undefined,
      noiseSuppression: s.noiseSuppression,
      echoCancellation: s.echoCancellation,
      autoGainControl: s.autoGainControl,
    };
  };

  const closeMicAudioContext = useCallback(async () => {
    const context = micAudioContext.current;
    micAudioContext.current = null;
    if (context && context.state !== 'closed') {
      try {
        await context.close();
      } catch (error) {
        notify(`Não foi possível encerrar o processamento do microfone: ${error.message}`);
      }
    }
  }, [notify]);

  const configureMicProcessor = useCallback(
    async (track, currentSettings = settingsRef.current) => {
      const shouldProcess = currentSettings.micSensitivity !== 100 || currentSettings.micGateEnabled;
      let processor = track.getProcessor();

      if (!shouldProcess) {
        if (processor) await track.stopProcessor();
        if (micAudioContext.current) await closeMicAudioContext();
        return;
      }

      if (processor?.update) {
        processor.update(currentSettings);
        return;
      }

      const context = new AudioContext();
      try {
        await context.resume();
        track.setAudioContext(context);
        processor = createMicAudioProcessor(currentSettings);
        await track.setProcessor(processor, false);
        micAudioContext.current = context;
      } catch (error) {
        if (context.state !== 'closed') {
          await context.close().catch(() => {});
        }
        throw error;
      }
    },
    [closeMicAudioContext],
  );

  const updateMicProcessing = useCallback(
    async (nextSettings = settingsRef.current) => {
      const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (!track) return;
      try {
        await configureMicProcessor(track, nextSettings);
      } catch (error) {
        notify(`Não foi possível aplicar a sensibilidade/gate do microfone: ${error.message}. O microfone continuará sem esse processamento.`);
      }
    },
    [room, configureMicProcessor, notify],
  );

  const setMic = useCallback(
    async (on) => {
      if (room.state !== 'connected') return;
      try {
        const publication = await room.localParticipant.setMicrophoneEnabled(on, micOptions());
        if (on) {
          const track = publication?.track || room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
          if (track) {
            try {
              await configureMicProcessor(track);
            } catch (error) {
              notify(`Não foi possível aplicar a sensibilidade/gate do microfone: ${error.message}. O microfone continuará sem esse processamento.`);
            }
          }
        }
      } catch (err) {
        notify(`Não foi possível usar o microfone: ${err.message}`);
        setMuted(true);
        emit({ muted: true });
      }
    },
    [room, notify, emit, configureMicProcessor],
  );

  const stopScreen = useCallback(async () => {
    const tracks = screenTracks.current;
    screenTracks.current = [];
    systemAudio.current?.stop();
    systemAudio.current = null;
    for (const track of tracks) {
      try {
        await room.localParticipant.unpublishTrack(track, true);
      } catch {
        track.stop?.();
      }
    }
    if (tracks.length) {
      setScreen(false);
      emit({ screen: false });
    }
  }, [room, emit]);

  const resetLocal = () => {
    screenTracks.current = [];
    setChannelId(null);
    setStatus('idle');
    setCamera(false);
    setScreen(false);
  };

  const leave = useCallback(
    async ({ silent = false } = {}) => {
      if (!state.current.channelId && room.state === 'disconnected') return;
      leaving.current = true;
      await stopScreen();
      await room.disconnect();
      await closeMicAudioContext();
      socket?.emit('voice:leave');
      resetLocal();
      if (!silent) play('leave');
    },
    [room, socket, stopScreen, play, closeMicAudioContext],
  );

  const join = useCallback(
    async (id) => {
      if (state.current.channelId === id && room.state !== 'disconnected') return;
      if (state.current.channelId || room.state !== 'disconnected') await leave({ silent: true });
      setStatus('connecting');
      setChannelId(id);
      try {
        const { token, url } = await api('/voice-token', { method: 'POST', body: { channelId: id } });
        leaving.current = false;
        await room.connect(url, token);
        const { muted: m, deafened: d } = state.current;
        socket.emit('voice:join', { channelId: id });
        socket.emit('voice:update', { muted: m, deafened: d });
        const out = settingsRef.current.outId;
        if (out) room.switchActiveDevice('audiooutput', out).catch(() => {});
        room.startAudio().catch(() => {});
        setStatus('connected');
        play('join');
        if (!m && !d) await setMic(true);
      } catch (err) {
        leaving.current = true;
        await room.disconnect();
        await closeMicAudioContext();
        resetLocal();
        notify(`Não foi possível entrar na sala de voz: ${err.message}`);
      }
    },
    [room, socket, leave, setMic, notify, play, closeMicAudioContext],
  );

  const toggleMute = useCallback(() => {
    const { muted: m, deafened: d } = state.current;
    // Assim como no Discord: desmutar enquanto ensurdecido também volta a ouvir.
    const nextMuted = d ? false : !m;
    setMuted(nextMuted);
    setDeafened(false);
    setMic(!nextMuted);
    emit({ muted: nextMuted, deafened: false });
    play(nextMuted ? 'mute' : 'unmute');
  }, [setMic, emit, play]);

  const toggleDeafen = useCallback(() => {
    const { muted: m, deafened: d } = state.current;
    const nextDeaf = !d;
    setDeafened(nextDeaf);
    setMic(!nextDeaf && !m);
    emit({ deafened: nextDeaf });
    play(nextDeaf ? 'mute' : 'unmute');
  }, [setMic, emit, play]);

  const toggleCamera = useCallback(async () => {
    if (room.state !== 'connected') return;
    const next = !state.current.camera;
    try {
      await room.localParticipant.setCameraEnabled(next, {
        deviceId: settingsRef.current.camId || undefined,
        resolution: VideoPresets.h720.resolution,
      });
      setCamera(next);
      emit({ video: next });
    } catch (err) {
      notify(`Não foi possível usar a câmera: ${err.message}`);
    }
  }, [room, emit, notify]);

  /** Inicia o compartilhamento. No app desktop, `sourceId` vem do seletor de telas/janelas. */
  const startScreen = useCallback(
    async ({ sourceId, audio }) => {
      if (room.state !== 'connected') return;
      await stopScreen();
      const q = SCREEN_QUALITIES[settingsRef.current.screenQuality] || SCREEN_QUALITIES['1080p30'];
      // No app desktop, o áudio vem do capturador nativo (que exclui o som do Minicord), não da tela.
      const nativeAudio = audio && nativeSystemAudioAvailable();
      const browserAudio = audio && !nativeAudio;
      let stream;
      try {
        if (window.minicordDesktop) await window.minicordDesktop.selectSource(sourceId, browserAudio);
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: q.width },
            height: { ideal: q.height },
            frameRate: { ideal: q.frameRate, max: q.frameRate },
          },
          audio: browserAudio
            ? {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                // Pede para não capturar o próprio Minicord (evita que os amigos ouçam a própria voz de volta).
                restrictOwnAudio: true,
                suppressLocalAudioPlayback: false,
              }
            : false,
          systemAudio: browserAudio ? 'include' : 'exclude',
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
        });
      } catch (err) {
        if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
          notify(`Não foi possível compartilhar a tela: ${err.message}`);
        }
        return;
      }

      try {
        const [videoTrack] = stream.getVideoTracks();
        videoTrack.contentHint = q.frameRate >= 60 ? 'motion' : 'detail';
        const videoPub = await room.localParticipant.publishTrack(videoTrack, {
          source: Track.Source.ScreenShare,
          simulcast: false,
          videoEncoding: { maxBitrate: q.bitrate, maxFramerate: q.frameRate },
          degradationPreference: q.frameRate >= 60 ? 'maintain-framerate' : 'maintain-resolution',
        });
        screenTracks.current = [videoPub.track];

        if (nativeAudio) {
          try {
            const capture = await createSystemAudioTrack();
            systemAudio.current = capture;
            const audioPub = await room.localParticipant.publishTrack(capture.track, SCREEN_AUDIO_PUBLISH);
            screenTracks.current.push(audioPub.track);
          } catch (err) {
            systemAudio.current?.stop();
            systemAudio.current = null;
            notify(`Não foi possível capturar o áudio do computador (${err.message}). Compartilhando só o vídeo.`);
          }
        } else {
          const [audioTrack] = stream.getAudioTracks();
          if (audioTrack) {
            const audioPub = await room.localParticipant.publishTrack(audioTrack, SCREEN_AUDIO_PUBLISH);
            screenTracks.current.push(audioPub.track);
          }
        }

        // Usuário clicou em "parar de compartilhar" na barra do navegador.
        videoTrack.addEventListener('ended', () => stopScreen());
        setScreen(true);
        emit({ screen: true });
      } catch (err) {
        stream.getTracks().forEach((t) => t.stop());
        await stopScreen();
        notify(`Falha ao transmitir a tela: ${err.message}`);
      }
    },
    [room, stopScreen, emit, notify],
  );

  const setDevice = useCallback(
    async (kind, deviceId) => {
      const key = { audioinput: 'micId', videoinput: 'camId', audiooutput: 'outId' }[kind];
      updateSettings({ [key]: deviceId });
      if (room.state === 'connected' && deviceId) {
        try {
          await room.switchActiveDevice(kind, deviceId);
        } catch (err) {
          notify(`Não foi possível trocar o dispositivo: ${err.message}`);
        }
      }
    },
    [room, updateSettings, notify],
  );

  /** Reaplica supressão de ruído / cancelamento de eco no microfone atual. */
  const restartMic = useCallback(async () => {
    const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!track) return;
    try {
      await track.restartTrack(micOptions());
      await configureMicProcessor(track);
    } catch (error) {
      notify(`Não foi possível atualizar o processamento do microfone: ${error.message}`);
    }
  }, [room, configureMicProcessor, notify]);

  const setVolume = useCallback(
    (key, value) =>
      updateSettings((prev) => {
        const currentVolume = prev.volumes?.[key] ?? 1;
        const lastVolume = value > 0 ? value : currentVolume > 0 ? currentVolume : prev.lastVolumes?.[key] ?? 1;
        return {
          volumes: { ...prev.volumes, [key]: value },
          lastVolumes: { ...prev.lastVolumes, [key]: lastVolume },
        };
      }),
    [updateSettings],
  );
  const toggleVolumeMute = useCallback(
    (key) => {
      const currentVolume = settingsRef.current.volumes?.[key] ?? 1;
      setVolume(key, currentVolume === 0 ? settingsRef.current.lastVolumes?.[key] ?? 1 : 0);
    },
    [setVolume],
  );

  useEffect(() => {
    const onDisconnected = () => {
      if (leaving.current) return;
      void closeMicAudioContext();
      socket?.emit('voice:leave');
      resetLocal();
      notify('Você foi desconectado da sala de voz.');
    };
    const onReconnecting = () => setStatus('reconnecting');
    const onReconnected = () => setStatus('connected');
    const onJoin = () => play('otherJoin');
    const onLeave = () => play('otherLeave');
    const onLocalUnpublished = (pub) => {
      if (pub.source === Track.Source.Camera) {
        setCamera(false);
        emit({ video: false });
      }
    };
    room
      .on(RoomEvent.Disconnected, onDisconnected)
      .on(RoomEvent.Reconnecting, onReconnecting)
      .on(RoomEvent.Reconnected, onReconnected)
      .on(RoomEvent.ParticipantConnected, onJoin)
      .on(RoomEvent.ParticipantDisconnected, onLeave)
      .on(RoomEvent.LocalTrackUnpublished, onLocalUnpublished);
    return () => {
      room
        .off(RoomEvent.Disconnected, onDisconnected)
        .off(RoomEvent.Reconnecting, onReconnecting)
        .off(RoomEvent.Reconnected, onReconnected)
        .off(RoomEvent.ParticipantConnected, onJoin)
        .off(RoomEvent.ParticipantDisconnected, onLeave)
        .off(RoomEvent.LocalTrackUnpublished, onLocalUnpublished);
    };
  }, [room, socket, notify, play, emit, closeMicAudioContext]);

  // Se o socket reconectar (ex.: servidor reiniciou), avisa de novo em que sala estamos.
  useEffect(() => {
    if (!socket) return;
    const onConnect = () => {
      const s = state.current;
      if (s.channelId && room.state === 'connected') {
        socket.emit('voice:join', { channelId: s.channelId });
        socket.emit('voice:update', { muted: s.muted, deafened: s.deafened, video: s.camera, screen: s.screen });
      }
    };
    socket.on('connect', onConnect);
    return () => socket.off('connect', onConnect);
  }, [socket, room]);

  useEffect(
    () => () => {
      void room.disconnect().finally(() => closeMicAudioContext());
    },
    [room, closeMicAudioContext],
  );

  return {
    room,
    channelId,
    status,
    muted,
    deafened,
    camera,
    screen,
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    startScreen,
    stopScreen,
    setDevice,
    restartMic,
    updateMicProcessing,
    setVolume,
    toggleVolumeMute,
  };
}
