import { useEffect, useState } from 'react';

export default function Avatar({ user, size = 32, speaking = false, status }) {
  const name = user?.displayName || '?';
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [user?.avatar]);
  const photo = user?.avatar && !failed ? `/api/avatars/${user.id}?v=${user.avatar}` : null;
  return (
    <div
      className={`avatar${speaking ? ' speaking' : ''}`}
      style={{ width: size, height: size, background: user?.color || '#5865f2', fontSize: size * 0.42 }}
      title={name}
    >
      {photo ? <img className="avatar-photo" src={photo} alt="" draggable={false} onError={() => setFailed(true)} /> : name.trim().charAt(0).toUpperCase()}
      {status && <span className={`status-dot ${status}`} />}
    </div>
  );
}
