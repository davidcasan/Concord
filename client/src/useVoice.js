import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioPresets, Room, RoomEvent, Track, VideoPresets } from 'livekit-client';
import { api } from './api.js';
import { sounds } from './sounds.js';
import { SCREEN_QUALITIES } from './settings.js';
import { createSystemAudioTrack, nativeSystemAudioAvailable } from './systemAudio.js';
import { createMicAudioProcessor } from './audio/micProcessor.js';
import { RNNOISE_SAMPLE_RATE } from './audio/rnnoise.js';

const NO_SCREEN_AUDIO = { type: 'none' };
export const MAX_SCREENS = 2; // telas/janelas transmitidas ao mesmo tempo

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
  const room = useMemo(() => new Room({ adaptiveStream: { pauseVideoInBackground: false }, dynacast: true }), []);
  const [channelId, setChannelId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | connecting | connected | reconnecting
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [camera, setCamera] = useState(false);
  const [screen, setScreen] = useState(false);
  const [screenAudio, setScreenAudioState] = useState(NO_SCREEN_AUDIO); // fonte do áudio da transmissão
  const [screens, setScreens] = useState([]); // telas no ar: { sid, index, sourceId, name }

  const screenTracks = useRef([]); // vídeos e áudio da transmissão (para publicar/despublicar)
  const screenVideos = useRef([]); // só os vídeos: { sid, index, track, sourceId, name }
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
      // Com o RNNoise ligado, o filtro do navegador fica desligado para não processar duas vezes.
      noiseSuppression: s.noiseEngine === 'browser',
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
      const shouldProcess =
        currentSettings.micSensitivity !== 100 || currentSettings.micGateEnabled || currentSettings.noiseEngine === 'rnnoise';
      let processor = track.getProcessor();

      if (!shouldProcess) {
        if (processor) await track.stopProcessor();
        if (micAudioContext.current) await closeMicAudioContext();
        return;
      }

      if (processor?.update) {
        await processor.update(currentSettings);
        return;
      }

      const context = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE });
      try {
        await context.resume();
        track.setAudioContext(context);
        processor = createMicAudioProcessor(currentSettings);
        await track.setProcessor(processor, false);
        micAudioContext.current = context;
        if (processor.noiseError) {
          notify(`Não foi possível ligar a redução de ruído: ${processor.noiseError.message}. O microfone continuará sem ela.`);
        }
      } catch (error) {
        if (context.state !== 'closed') {
          await context.close().catch(() => {});
        }
        throw error;
      }
    },
    [closeMicAudioContext, notify],
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
    screenVideos.current = [];
    setScreenAudioState(NO_SCREEN_AUDIO);
    setScreens([]);
    if (tracks.length) {
      setScreen(false);
      emit({ screen: false });
    }
  }, [room, emit]);

  /** Para uma das telas. Quando a última sai, a transmissão inteira (inclusive o áudio) termina. */
  const removeScreen = useCallback(
    async (sid) => {
      const entry = screenVideos.current.find((e) => e.sid === sid);
      if (!entry) return;
      screenVideos.current = screenVideos.current.filter((e) => e !== entry);
      screenTracks.current = screenTracks.current.filter((t) => t !== entry.track);
      setScreens((list) => list.filter((x) => x.sid !== sid));
      try {
        await room.localParticipant.unpublishTrack(entry.track, true);
      } catch {
        entry.track.stop?.();
      }
      if (!screenVideos.current.length) await stopScreen();
    },
    [room, stopScreen],
  );

  /** Remove só o áudio da transmissão; o vídeo continua no ar. */
  const removeScreenAudio = useCallback(async () => {
    systemAudio.current?.stop();
    systemAudio.current = null;
    const audioTracks = screenTracks.current.filter((t) => t.source === Track.Source.ScreenShareAudio);
    screenTracks.current = screenTracks.current.filter((t) => !audioTracks.includes(t));
    for (const track of audioTracks) {
      try {
        await room.localParticipant.unpublishTrack(track, true);
      } catch {
        track.stop?.();
      }
    }
  }, [room]);

  /** Captura (via capturador nativo) a fonte de áudio pedida e publica como áudio da transmissão. */
  const addScreenAudio = useCallback(
    async (source) => {
      let capture;
      capture = await createSystemAudioTrack({
        source,
        onEnded: () => {
          if (systemAudio.current !== capture) return;
          notify(`O áudio de ${source.name || 'a fonte escolhida'} terminou (o aplicativo foi fechado?). A transmissão continua sem áudio.`);
          void removeScreenAudio().then(() => setScreenAudioState(NO_SCREEN_AUDIO));
        },
      });
      systemAudio.current = capture;
      try {
        const audioPub = await room.localParticipant.publishTrack(capture.track, SCREEN_AUDIO_PUBLISH);
        screenTracks.current.push(audioPub.track);
      } catch (error) {
        capture.stop();
        systemAudio.current = null;
        throw error;
      }
    },
    [room, notify, removeScreenAudio],
  );

  /**
   * Troca a fonte do áudio com a transmissão no ar, sem mexer no vídeo.
   * `source`: { type: 'none' } | { type: 'system' } | { type: 'window', windowId } | { type: 'app', pid }.
   */
  const setScreenAudio = useCallback(
    async (source) => {
      if (!screenTracks.current.length) return;
      try {
        if (source.type === 'none') await removeScreenAudio();
        else if (systemAudio.current) await systemAudio.current.switchSource(source);
        else await addScreenAudio(source);
        setScreenAudioState(source);
      } catch (err) {
        notify(`Não foi possível trocar o áudio da transmissão: ${err.message}`);
      }
    },
    [notify, removeScreenAudio, addScreenAudio],
  );

  const resetLocal = () => {
    screenTracks.current = [];
    screenVideos.current = [];
    setScreenAudioState(NO_SCREEN_AUDIO);
    setScreens([]);
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

  /** Captura uma tela/janela e publica como uma transmissão de vídeo (até duas ao mesmo tempo). */
  const publishScreenVideo = useCallback(
    async ({ sourceId, sourceName, browserAudio = false }) => {
      const base = SCREEN_QUALITIES[settingsRef.current.screenQuality] || SCREEN_QUALITIES['1080p30'];
      // Com duas telas no ar, a segunda é mais leve (30 fps, 70% do bitrate) para caber na banda e no processador.
      const q = screenVideos.current.length ? { ...base, frameRate: Math.min(base.frameRate, 30), bitrate: Math.round(base.bitrate * 0.7) } : base;
      if (window.minicordDesktop) await window.minicordDesktop.selectSource(sourceId, browserAudio);
      const stream = await navigator.mediaDevices.getDisplayMedia({
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

      const [videoTrack] = stream.getVideoTracks();
      videoTrack.contentHint = q.frameRate >= 60 ? 'motion' : 'detail';
      const index = screenVideos.current.some((e) => e.index === 1) ? 2 : 1;
      let pub;
      try {
        pub = await room.localParticipant.publishTrack(videoTrack, {
          source: Track.Source.ScreenShare,
          name: `screen-${index}`,
          simulcast: false,
          videoEncoding: { maxBitrate: q.bitrate, maxFramerate: q.frameRate },
          degradationPreference: q.frameRate >= 60 ? 'maintain-framerate' : 'maintain-resolution',
        });
      } catch (error) {
        stream.getTracks().forEach((t) => t.stop());
        throw error;
      }
      const entry = { sid: pub.trackSid, index, track: pub.track, sourceId, name: sourceName || '' };
      screenVideos.current.push(entry);
      screenTracks.current.push(pub.track);
      setScreens((list) => [...list, { sid: entry.sid, index, sourceId, name: entry.name }]);
      // Usuário clicou em "parar de compartilhar" na barra do navegador (ou a janela foi fechada).
      videoTrack.addEventListener('ended', () => void removeScreen(entry.sid));
      return { entry, stream };
    },
    [room, removeScreen],
  );

  const isCancel = (err) => err.name === 'NotAllowedError' || err.name === 'AbortError';

  /**
   * Inicia o compartilhamento com uma ou duas telas. No app desktop, `sources` ([{ sourceId, sourceName }])
   * vem do seletor de telas/janelas. O áudio é único e independente das telas: `audio` é a fonte escolhida
   * (todo o PC sem o som do Concord, ou só de um aplicativo/janela).
   */
  const startScreen = useCallback(
    async ({ sources, sourceId, sourceName, audio }) => {
      if (room.state !== 'connected') return;
      await stopScreen();
      const list = (sources?.length ? sources : [{ sourceId, sourceName }]).slice(0, MAX_SCREENS);
      const audioSource = audio && typeof audio === 'object' ? audio : audio ? { type: 'system' } : NO_SCREEN_AUDIO;
      const nativeAudio = audioSource.type !== 'none' && nativeSystemAudioAvailable();
      const browserAudio = audioSource.type !== 'none' && !nativeAudio;

      let first;
      try {
        first = await publishScreenVideo({ ...list[0], browserAudio });
      } catch (err) {
        await stopScreen();
        if (!isCancel(err)) notify(`Não foi possível compartilhar a tela: ${err.message}`);
        return;
      }

      try {
        if (nativeAudio) {
          try {
            await addScreenAudio(audioSource);
            setScreenAudioState(audioSource);
          } catch (err) {
            notify(`Não foi possível capturar o áudio escolhido (${err.message}). Compartilhando só o vídeo.`);
          }
        } else {
          const [audioTrack] = first.stream.getAudioTracks();
          if (audioTrack) {
            const audioPub = await room.localParticipant.publishTrack(audioTrack, SCREEN_AUDIO_PUBLISH);
            screenTracks.current.push(audioPub.track);
          }
        }
        setScreen(true);
        emit({ screen: true });
      } catch (err) {
        first.stream.getTracks().forEach((t) => t.stop());
        await stopScreen();
        notify(`Falha ao transmitir a tela: ${err.message}`);
        return;
      }

      for (const extra of list.slice(1)) {
        try {
          await publishScreenVideo({ ...extra });
        } catch (err) {
          if (!isCancel(err)) notify(`Não foi possível compartilhar a segunda tela: ${err.message}`);
        }
      }
    },
    [room, stopScreen, emit, notify, addScreenAudio, publishScreenVideo],
  );

  /** Adiciona outra tela/janela a uma transmissão já no ar (o áudio não muda). */
  const addScreen = useCallback(
    async ({ sourceId, sourceName }) => {
      if (room.state !== 'connected' || !screenVideos.current.length) return;
      if (screenVideos.current.length >= MAX_SCREENS) {
        notify(`O limite é de ${MAX_SCREENS} telas por transmissão.`);
        return;
      }
      if (sourceId && screenVideos.current.some((e) => e.sourceId === sourceId)) {
        notify('Essa tela já está sendo compartilhada.');
        return;
      }
      try {
        await publishScreenVideo({ sourceId, sourceName });
      } catch (err) {
        if (!isCancel(err)) notify(`Não foi possível adicionar a tela: ${err.message}`);
      }
    },
    [room, notify, publishScreenVideo],
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
    screenAudio,
    screens,
    addScreen,
    removeScreen,
    setScreenAudio,
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
