import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { errorMessage, isApiError } from '../api/client';
import { useAcceptInvite } from '../api/hooks';
import { Wordmark } from '../components/Shell';

const MIN_PASSWORD = 10;

export function InvitePage() {
  const { token = '' } = useParams();
  const accept = useAcceptInvite();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = name.trim().length > 0 && password.length >= MIN_PASSWORD && confirm === password && token.length >= 16;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid || accept.isPending) return;
    accept.mutate({ token, name: name.trim(), password }, { onSuccess: () => nav('/map', { replace: true }) });
  };

  let error: string | null = null;
  if (accept.isError) {
    if (isApiError(accept.error, 410)) error = 'This invite link is invalid, expired, or has already been used. Ask an admin for a new one.';
    else if (isApiError(accept.error, 429)) error = 'Too many attempts — wait a minute and try again.';
    else error = errorMessage(accept.error);
  }

  if (token.length < 16) {
    return (
      <div className="auth-page">
        <div className="card auth-card">
          <div className="auth-card__brand">
            <Wordmark />
          </div>
          <h1 className="auth-card__title">Invalid invite link</h1>
          <p className="muted">This link is incomplete. Ask an admin to send it again.</p>
          <Link to="/login" className="btn btn--block">
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={onSubmit} noValidate>
        <div className="auth-card__brand">
          <Wordmark />
          <p className="muted">You have been invited to the campaign map</p>
        </div>
        <h1 className="auth-card__title">Set up your account</h1>
        <label className="field">
          <span className="field__label">Your name</span>
          <input type="text" name="name" autoComplete="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Password</span>
          <input
            type="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby="pw-hint"
            aria-invalid={tooShort || undefined}
          />
          <span id="pw-hint" className={`field__hint${tooShort ? ' field__hint--error' : ''}`}>
            At least {MIN_PASSWORD} characters{tooShort ? ` (${MIN_PASSWORD - password.length} more)` : ''}.
          </span>
        </label>
        <label className="field">
          <span className="field__label">Confirm password</span>
          <input
            type="password"
            name="confirm"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch || undefined}
          />
          {mismatch && <span className="field__hint field__hint--error">Passwords do not match.</span>}
        </label>
        {error && (
          <div className="alert alert--danger" role="alert">
            {error}
          </div>
        )}
        {touched && !valid && !error && (
          <div className="alert alert--warn" role="alert">
            Fill in your name and matching passwords of at least {MIN_PASSWORD} characters.
          </div>
        )}
        <button type="submit" className="btn btn--primary btn--block" disabled={accept.isPending}>
          {accept.isPending ? 'Creating account…' : 'Create account and sign in'}
        </button>
        <p className="muted small auth-card__note">
          By continuing you agree to use the voters list for this election campaign only and to keep it confidential.
        </p>
      </form>
    </div>
  );
}
