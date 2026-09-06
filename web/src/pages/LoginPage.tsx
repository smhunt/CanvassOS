import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { errorMessage, isApiError } from '../api/client';
import { useLogin } from '../api/hooks';
import { PasswordField } from '../components/PasswordField';
import { Wordmark } from '../components/Shell';

export function LoginPage() {
  const login = useLogin();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const from = (loc.state as { from?: string } | null)?.from;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    login.mutate(
      { email: email.trim(), password },
      { onSuccess: () => nav(from && from !== '/login' ? from : '/map', { replace: true }) },
    );
  };

  let error: string | null = null;
  if (login.isError) {
    if (isApiError(login.error, 401)) error = 'That email and password did not match.';
    else if (isApiError(login.error, 429)) error = 'Too many attempts — wait a minute and try again.';
    else error = errorMessage(login.error);
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={onSubmit} noValidate>
        <div className="auth-card__brand">
          <Wordmark />
          <p className="muted">Middlesex Centre voter map</p>
        </div>
        <h1 className="auth-card__title">Sign in</h1>
        <label className="field">
          <span className="field__label">Email</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <PasswordField
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
        />
        {error && (
          <div className="alert alert--danger" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn btn--primary btn--block" disabled={login.isPending || !email || !password}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small auth-card__note">
          Forgotten your password? There is no self-serve reset — ask an organiser to re-invite you,
          or whoever runs the server can issue a link with <code>make reset-password</code>.
        </p>
        <p className="muted small auth-card__note">
          Accounts are by invitation. The voters list is provided under the <em>Municipal Elections Act</em> for election
          purposes only; every sign-in and lookup is logged.
        </p>
      </form>
    </div>
  );
}
