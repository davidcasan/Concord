export default function Avatar({ user, size = 32, speaking = false, status }) {
  const name = user?.displayName || '?';
  return (
    <div
      className={`avatar${speaking ? ' speaking' : ''}`}
      style={{ width: size, height: size, background: user?.color || '#5865f2', fontSize: size * 0.42 }}
      title={name}
    >
      {name.trim().charAt(0).toUpperCase()}
      {status && <span className={`status-dot ${status}`} />}
    </div>
  );
}
