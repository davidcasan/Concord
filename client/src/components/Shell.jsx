import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { RoomContext } from '@livekit/components-react';
import { getToken } from '../api.js';
import { sounds } from '../sounds.js';
import { useSettings } from '../settings.js';
import { useVoice } from '../useVoice.js';
import Sidebar from './Sidebar.jsx';
import TextChannel from './TextChannel.jsx';
import VoiceView, { VoiceAudio } from './VoiceView.jsx';
import MemberList from './MemberList.jsx';
import ChannelModal from './ChannelModal.jsx';
import SettingsModal from './SettingsModal.jsx';
import ScreenPicker from './ScreenPicker.jsx';
import ShareManagerModal from './ShareManagerModal.jsx';
import { StreamPopups } from './StreamPopups.jsx';
import VolumeContextMenu from './VolumeContextMenu.jsx';

const byId = (list) => Object.fromEntries(list.map((u) => [u.id, u]));

export default function Shell({ onLogout, onSessionConflict }) {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState(null);
  const [users, setUsers] = useState({});
  const [online, setOnline] = useState(() => new Set());
  const [channels, setChannels] = useState([]);
  const [voiceStates, setVoiceStates] = useState({});
  const [messages, setMessages] = useState({});
  const [unread, setUnread] = useState(() => new Set());
  const [typing, setTyping] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [modal, setModal] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [showMembers, setShowMembers] = useState(true);
  const [volumeMenu, setVolumeMenu] = useState(null);
  const [settings, updateSettings] = useSettings();

  const notify = useCallback((text) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const voice = useVoice({ socket, settings, updateSettings, notify });

  const refs = useRef({});
  refs.current = { me, activeId, settings, onLogout, onSessionConflict };

  const openVolumeMenu = useCallback((event, key, name, source) => {
    event.preventDefault();
    const width = 244;
    const height = 132;
    setVolumeMenu({
      key,
      name,
      source,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    });
  }, []);

  const closeVolumeMenu = useCallback(() => setVolumeMenu(null), []);

  useEffect(() => {
    const s = io({ auth: { token: getToken() } });
    const typingTimers = {};

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', (err) => {
      if (err.message === 'unauthorized') refs.current.onLogout();
      else if (err.message === 'already_connected') {
        refs.current.onSessionConflict?.('Este usuário já está logado em outro dispositivo. Desconecte a outra sessão e tente novamente.');
      }
    });
    s.on('init', (d) => {
      setMe(d.me);
      setUsers(byId(d.users));
      setOnline(new Set(d.online));
      setChannels(d.channels);
      setVoiceStates(d.voice);
      setMessages({}); // força recarregar o histórico após reconectar
    });
    s.on('users', ({ users: list, online: ids }) => {
      setUsers(byId(list));
      setOnline(new Set(ids));
      setMe((m) => list.find((u) => u.id === m?.id) || m);
    });
    s.on('channels', setChannels);
    s.on('voice:states', setVoiceStates);
    s.on('message:new', (msg) => {
      setMessages((prev) => {
        const c = prev[msg.channelId];
        if (!c?.loaded || c.items.some((m) => m.id === msg.id)) return prev;
        return { ...prev, [msg.channelId]: { ...c, items: [...c.items, msg] } };
      });
      const key = `${msg.channelId}:${msg.userId}`;
      clearTimeout(typingTimers[key]);
      setTyping((t) => {
        if (!t[key]) return t;
        const n = { ...t };
        delete n[key];
        return n;
      });
      const { me: current, activeId: active, settings: st } = refs.current;
      if (msg.userId !== current?.id && (msg.channelId !== active || document.hidden)) {
        if (msg.channelId !== active) setUnread((u) => new Set(u).add(msg.channelId));
        if (st.sounds) sounds.message();
      }
    });
    s.on('message:deleted', ({ id, channelId }) => {
      setMessages((prev) => {
        const c = prev[channelId];
        if (!c) return prev;
        return { ...prev, [channelId]: { ...c, items: c.items.filter((m) => m.id !== id) } };
      });
    });
    s.on('typing', ({ channelId, userId }) => {
      const key = `${channelId}:${userId}`;
      clearTimeout(typingTimers[key]);
      setTyping((t) => ({ ...t, [key]: true }));
      typingTimers[key] = setTimeout(() => {
        setTyping((t) => {
          const n = { ...t };
          delete n[key];
          return n;
        });
      }, 4000);
    });

    setSocket(s);
    return () => {
      Object.values(typingTimers).forEach(clearTimeout);
      s.disconnect();
    };
  }, []);

  // Escolhe uma sala válida quando a lista muda (ex.: sala atual foi apagada).
  useEffect(() => {
    if (!channels.length) return;
    if (!channels.some((c) => c.id === activeId)) {
      setActiveId((channels.find((c) => c.type === 'text') || channels[0]).id);
    }
  }, [channels, activeId]);

  const { channelId: voiceChannelId, leave: leaveVoice } = voice;
  useEffect(() => {
    if (voiceChannelId && channels.length && !channels.some((c) => c.id === voiceChannelId)) leaveVoice();
  }, [channels, voiceChannelId, leaveVoice]);

  useEffect(() => {
    setUnread((u) => {
      if (!u.has(activeId)) return u;
      const n = new Set(u);
      n.delete(activeId);
      return n;
    });
  }, [activeId]);

  useEffect(() => {
    document.title = unread.size ? `(${unread.size}) Concord` : 'Concord';
  }, [unread]);

  const active = channels.find((c) => c.id === activeId);
  const voiceChannel = channels.find((c) => c.id === voice.channelId);

  const selectChannel = (channel) => {
    setActiveId(channel.id);
    if (channel.type === 'voice' && voice.channelId !== channel.id) voice.join(channel.id);
  };

  const openScreenShare = () => {
    if (voice.screen) voice.stopScreen();
    else setModal({ type: 'screen' });
  };

  const openShareManager = () => setModal({ type: 'shareManager' });

  const voiceControls = { ...voice, openScreenShare, openShareManager };

  if (!me) return <div className="splash">{connected ? 'Carregando…' : 'Conectando ao servidor…'}</div>;

  return (
    <RoomContext.Provider value={voice.room}>
      <div className={`app${showMembers ? '' : ' no-members'}`}>
        <Sidebar
          me={me}
          users={users}
          channels={channels}
          activeId={activeId}
          unread={unread}
          voiceStates={voiceStates}
          volumes={settings.volumes}
          setVolume={voice.setVolume}
          openVolumeMenu={openVolumeMenu}
          voice={voiceControls}
          voiceChannel={voiceChannel}
          onSelect={selectChannel}
          onCreate={(type) => setModal({ type: 'create', channelType: type })}
          onRename={(channel) => setModal({ type: 'rename', channel })}
          socket={socket}
          notify={notify}
          onOpenSettings={() => setModal({ type: 'settings' })}
        />

        <main className="main">
          {active?.type === 'text' && (
            <TextChannel
              key={active.id}
              channel={active}
              socket={socket}
              me={me}
              users={users}
              cache={messages[active.id]}
              setMessages={setMessages}
              typing={typing}
              notify={notify}
              showMembers={showMembers}
              onToggleMembers={() => setShowMembers((v) => !v)}
            />
          )}
          {active?.type === 'voice' && (
            <VoiceView
              channel={active}
              voice={voiceControls}
              members={voiceStates[active.id] || []}
              users={users}
              volumes={settings.volumes}
              notify={notify}
              openVolumeMenu={openVolumeMenu}
            />
          )}
        </main>

        {showMembers && <MemberList users={users} online={online} voiceStates={voiceStates} channels={channels} />}
      </div>

      <VoiceAudio deafened={voice.deafened} volumes={settings.volumes} />
      <StreamPopups voice={voice} users={users} autoOpen={!!settings.autoPopup} />
      {volumeMenu && (
        <VolumeContextMenu
          menu={volumeMenu}
          volume={settings.volumes?.[volumeMenu.key] ?? 1}
          onVolumeChange={(value) => voice.setVolume(volumeMenu.key, value)}
          onToggleMute={() => voice.toggleVolumeMute(volumeMenu.key)}
          onClose={closeVolumeMenu}
        />
      )}

      {(modal?.type === 'create' || modal?.type === 'rename') && (
        <ChannelModal
          socket={socket}
          channelType={modal.channelType}
          channel={modal.channel}
          onClose={() => setModal(null)}
          onCreated={(id) => setActiveId(id)}
        />
      )}
      {modal?.type === 'settings' && (
        <SettingsModal
          me={me}
          settings={settings}
          updateSettings={updateSettings}
          voice={voice}
          onLogout={onLogout}
          notify={notify}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'screen' && (
        <ScreenPicker
          settings={settings}
          updateSettings={updateSettings}
          onClose={() => setModal(null)}
          onPick={(opts) => {
            setModal(null);
            voice.startScreen(opts);
          }}
        />
      )}

      {modal?.type === 'shareManager' && (
        <ShareManagerModal
          voice={voice}
          updateSettings={updateSettings}
          onAddScreen={() => setModal({ type: 'screenAdd' })}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'screenAdd' && (
        <ScreenPicker
          mode="add"
          settings={settings}
          updateSettings={updateSettings}
          taken={voice.screens.map((s) => s.sourceId).filter(Boolean)}
          onClose={() => setModal({ type: 'shareManager' })}
          onPick={({ sources }) => {
            setModal({ type: 'shareManager' });
            voice.addScreen(sources[0]);
          }}
        />
      )}

      {!connected && <div className="offline-banner">Conexão com o servidor perdida. Tentando reconectar…</div>}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    </RoomContext.Provider>
  );
}
