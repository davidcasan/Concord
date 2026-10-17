import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Login({ onLogin, notice = '' }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [inviteRequired, setInviteRequired] = useState(true);
  const [error, setError] = useState(notice);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/config').then((c) => setInviteRequired(c.inviteRequired)).catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (mode === 'register' && password !== confirm) return setError('As senhas não conferem.');
    setBusy(true);
    try {
      const body = mode === 'login' ? { username, password } : { username, password, inviteCode };
      const { token } = await api(mode === 'login' ? '/login' : '/register', { method: 'POST', body });
      onLogin(token);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const switchMode = (m) => {
    setMode(m);
    setError('');
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <img className="auth-logo" src="/concord.svg" alt="Concord" />
        <h1>{mode === 'login' ? 'Boas-vindas ao Concord!' : 'Criar uma conta'}</h1>
        <p className="muted">{mode === 'login' ? 'Que bom te ver de novo.' : 'Peça o código de convite para quem criou o servidor.'}</p>

        <label>
          Usuário
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
        </label>
        {mode === 'register' && (
          <>
            <label>
              Confirmar senha
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </label>
            {inviteRequired && (
              <label>
                Código de convite
                <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} required />
              </label>
            )}
          </>
        )}

        {error && <div className="form-error">{error}</div>}

        <button className="btn primary block" disabled={busy}>
          {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
        </button>

        <p className="auth-switch">
          {mode === 'login' ? (
            <>
              Não tem conta?{' '}
              <button type="button" className="link" onClick={() => switchMode('register')}>
                Criar conta
              </button>
            </>
          ) : (
            <>
              Já tem conta?{' '}
              <button type="button" className="link" onClick={() => switchMode('login')}>
                Entrar
              </button>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
