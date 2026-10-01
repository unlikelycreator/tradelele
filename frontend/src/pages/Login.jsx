import { useState } from 'react';
import { api, setToken } from '../lib/api.js';

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token } = await api.post('/auth/login', { password });
      setToken(token);
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="panel login-card" onSubmit={submit}>
        <div className="brand big"><span className="dot" /> ZOOP/TRADE</div>
        <p className="muted">Private crypto trading desk. Enter the dashboard password from <code>backend/.env</code>.</p>
        <input className="input" type="password" autoFocus placeholder="Dashboard password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="err">{error}</div>}
        <button className="btn primary" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
