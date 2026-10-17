import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './components/Login.jsx';
import Shell from './components/Shell.jsx';

export default function App() {
  const [status, setStatus] = useState(getToken() ? 'checking' : 'out');
  const [loginNotice, setLoginNotice] = useState('');

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
    setLoginNotice('');
    setStatus('out');
  };

  if (status === 'checking') return <div className="splash">Carregando…</div>;
  if (status === 'out') {
    return (
      <Login
        notice={loginNotice}
        onLogin={(token) => {
          setToken(token);
          setLoginNotice('');
          setStatus('in');
        }}
      />
    );
  }
  return (
    <Shell
      onLogout={logout}
      onSessionConflict={(message) => {
        setToken(null);
        setLoginNotice(message);
        setStatus('out');
      }}
    />
  );
}
