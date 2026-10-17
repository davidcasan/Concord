import { useState } from 'react';
import { useSpeakingParticipants } from '@livekit/components-react';
import {
  Hash,
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  Pencil,
  PhoneOff,
  Plus,
  ScreenShare,
  ScreenShareOff,
  AudioLines,
  Settings,
  Trash,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { emitAck } from '../api.js';
import Avatar from './Avatar.jsx';

export default function Sidebar({
  me,
  users,
  channels,
  activeId,
  unread,
  voiceStates,
  volumes,
  setVolume,
  openVolumeMenu,
  voice,
  voiceChannel,
  onSelect,
  onCreate,
  onRename,
  socket,
  notify,
  onOpenSettings,
}) {
  const text = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');
  const canManage = (c) => me.isAdmin || c.createdBy === me.id;

  const remove = async (channel) => {
    if (!window.confirm(`Apagar a sala "${channel.name}"? As mensagens dela também serão apagadas.`)) return;
    try {
      await emitAck(socket, 'channel:delete', { id: channel.id });
    } catch (err) {
      notify(err.message);
    }
  };

  const channelActions = (c) =>
    canManage(c) && (
      <span className="channel-actions">
        <button
          title="Renomear"
          onClick={(e) => {
            e.stopPropagation();
            onRename(c);
          }}
        >
          <Pencil size={14} />
        </button>
        <button
          title="Apagar"
          onClick={(e) => {
            e.stopPropagation();
            remove(c);
          }}
        >
          <Trash size={14} />
        </button>
      </span>
    );

  return (
    <aside className="sidebar">
      <header className="server-header"><img src="/concord.svg" alt="" /> Concord</header>

      <div className="channel-scroll">
        <div className="category">
          <span>Salas de texto</span>
          <button title="Criar sala de texto" onClick={() => onCreate('text')}>
            <Plus size={16} />
          </button>
        </div>
        {text.map((c) => (
          <div
            key={c.id}
            className={`channel${c.id === activeId ? ' active' : ''}${unread.has(c.id) ? ' unread' : ''}`}
            onClick={() => onSelect(c)}
          >
            <Hash size={18} className="channel-icon" />
            <span className="channel-name">{c.name}</span>
            {channelActions(c)}
          </div>
        ))}

        <div className="category">
          <span>Salas de voz</span>
          <button title="Criar sala de voz" onClick={() => onCreate('voice')}>
            <Plus size={16} />
          </button>
        </div>
        {voiceChannels.map((c) => (
          <div key={c.id}>
            <div className={`channel${c.id === activeId ? ' active' : ''}`} onClick={() => onSelect(c)}>
              <Volume2 size={18} className="channel-icon" />
              <span className="channel-name">{c.name}</span>
              {channelActions(c)}
            </div>
            <VoiceMembers
              members={voiceStates[c.id] || []}
              users={users}
              currentUserId={me.id}
              volumes={volumes}
              setVolume={setVolume}
              openVolumeMenu={openVolumeMenu}
              live={voice.channelId === c.id && voice.status === 'connected'}
            />
          </div>
        ))}
      </div>

      {voice.channelId && (
        <div className="voice-panel">
          <div className="voice-panel-info">
            <div className={`voice-status ${voice.status}`}>
              {voice.status === 'connected' ? 'Voz conectada' : voice.status === 'reconnecting' ? 'Reconectando…' : 'Conectando…'}
            </div>
            <div className="voice-room-name" onClick={() => voiceChannel && onSelect(voiceChannel)}>
              {voiceChannel?.name}
            </div>
          </div>
          <div className="voice-panel-buttons">
            <button className={`icon-btn${voice.camera ? ' on' : ''}`} title={voice.camera ? 'Desligar câmera' : 'Ligar câmera'} onClick={voice.toggleCamera}>
              {voice.camera ? <Video size={18} /> : <VideoOff size={18} />}
            </button>
            <button
              className={`icon-btn${voice.screen ? ' on' : ''}`}
              title={voice.screen ? 'Parar de compartilhar' : 'Compartilhar tela'}
              onClick={voice.openScreenShare}
            >
              {voice.screen ? <ScreenShareOff size={18} /> : <ScreenShare size={18} />}
            </button>
            {voice.screen && window.minicordDesktop?.listAudioApps && (
              <button className="icon-btn" title="Áudio da transmissão" onClick={voice.openScreenAudio}>
                <AudioLines size={18} />
              </button>
            )}
            <button className="icon-btn danger" title="Desconectar" onClick={() => voice.leave()}>
              <PhoneOff size={18} />
            </button>
          </div>
        </div>
      )}

      <div className="user-panel">
        <Avatar user={me} size={32} status="online" />
        <div className="user-panel-name">
          <div className="name">{me.displayName}</div>
          <div className="sub">@{me.username}</div>
        </div>
        <button className={`icon-btn${voice.muted || voice.deafened ? ' off' : ''}`} title={voice.muted ? 'Desmutar' : 'Mutar'} onClick={voice.toggleMute}>
          {voice.muted || voice.deafened ? <MicOff size={18} /> : <Mic size={18} />}
        </button>
        <button className={`icon-btn${voice.deafened ? ' off' : ''}`} title={voice.deafened ? 'Voltar a ouvir' : 'Ensurdecer'} onClick={voice.toggleDeafen}>
          {voice.deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
        </button>
        <button className="icon-btn" title="Configurações" onClick={onOpenSettings}>
          <Settings size={18} />
        </button>
      </div>
    </aside>
  );
}

function VoiceMembers({ members, users, currentUserId, volumes, setVolume, openVolumeMenu, live }) {
  const speaking = useSpeakingParticipants();
  const speakingIds = live ? new Set(speaking.map((p) => p.identity)) : new Set();
  if (!members.length) return null;
  return (
    <div className="voice-members">
      {members.map((m) => {
        const user = users[m.userId];
        const volume = volumes?.[String(m.userId)] ?? 1;
        return (
          <VoiceMember
            key={m.userId}
            member={m}
            user={user}
            currentUser={m.userId === currentUserId}
            speaking={speakingIds.has(String(m.userId)) && !m.muted}
            volume={volume}
            onVolumeChange={(value) => setVolume(String(m.userId), value)}
            onContextMenu={(event) => openVolumeMenu(event, String(m.userId), nameFor(user), 'mic')}
          />
        );
      })}
    </div>
  );
}

const nameFor = (user) => user?.displayName || '…';

function VoiceMember({ member, user, currentUser, speaking, volume, onVolumeChange, onContextMenu }) {
  const [showVolume, setShowVolume] = useState(false);
  const name = nameFor(user);

  return (
    <div className="voice-member" onContextMenu={currentUser ? undefined : onContextMenu}>
      <Avatar user={user} size={22} speaking={speaking} />
      <span className="voice-member-name">{name}</span>
      <span className="voice-member-icons">
        {member.screen && <span className="live-badge">AO VIVO</span>}
        {member.video && <Video size={14} />}
        {member.deafened ? <HeadphoneOff size={14} className="red" /> : member.muted && <MicOff size={14} className="red" />}
        {!currentUser && (
          <span className="voice-member-volume">
            <button
              className="voice-member-volume-button"
              type="button"
              title={`Volume de ${name}`}
              aria-label={`Volume de ${name}`}
              aria-expanded={showVolume}
              onClick={() => setShowVolume((open) => !open)}
            >
              {volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
            {showVolume && (
              <span className="voice-member-volume-pop">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(volume * 100)}
                  aria-label={`Volume do microfone de ${name}`}
                  onChange={(event) => onVolumeChange(Number(event.target.value) / 100)}
                />
                <span>{Math.round(volume * 100)}%</span>
              </span>
            )}
          </span>
        )}
      </span>
    </div>
  );
}
