import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './components/Login.jsx';
import Shell from './components/Shell.jsx';

export default function App() {
  const [status, setStatus] = useState(getToken() ? 'checking' : 'out');

  useEffect(() => {
    if (status !== 'checking') return;
    api('/me')
      .then(() => setStatus('in'))
      .catch((err) => {
        if (err.status === 401) setToken(null);
        setStatus(err.status === 401 ? 'out' : 'in');
      });
  }, [status]);

  const logout = async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
    setStatus('out');
  };

  if (status === 'checking') return <div className="splash">Carregando…</div>;
  if (status === 'out') {
    return (
      <Login
        onLogin={(token) => {
          setToken(token);
          setStatus('in');
        }}
      />
    );
  }
  return <Shell onLogout={logout} />;
}
