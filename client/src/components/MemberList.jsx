import { Volume2 } from 'lucide-react';
import Avatar from './Avatar.jsx';

export default function MemberList({ users, online, voiceStates, channels }) {
  const inVoice = {};
  for (const [channelId, list] of Object.entries(voiceStates)) {
    for (const m of list) inVoice[m.userId] = channels.find((c) => c.id === Number(channelId))?.name;
  }
  const all = Object.values(users);
  const on = all.filter((u) => online.has(u.id));
  const off = all.filter((u) => !online.has(u.id));

  const row = (u, isOnline) => (
    <div key={u.id} className={`member${isOnline ? '' : ' offline'}`}>
      <Avatar user={u} size={32} status={isOnline ? 'online' : 'offline'} />
      <div className="member-info">
        <div className="member-name" style={{ color: isOnline ? u.color : undefined }}>
          {u.displayName}
          {u.isAdmin && <span className="admin-badge">ADM</span>}
        </div>
        {inVoice[u.id] && (
          <div className="member-sub">
            <Volume2 size={12} /> {inVoice[u.id]}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <aside className="member-list">
      <div className="category static">Online — {on.length}</div>
      {on.map((u) => row(u, true))}
      {off.length > 0 && <div className="category static">Offline — {off.length}</div>}
      {off.map((u) => row(u, false))}
    </aside>
  );
}
