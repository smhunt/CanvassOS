import { Suspense, lazy, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { errorMessage, isApiError } from '../api/client';
import { useLogin } from '../api/hooks';
import { PasswordField } from '../components/PasswordField';
import { Wordmark } from '../components/Shell';
import { goToWaitlist } from '../product/goToWaitlist';
import { Tour } from '../product/Tour';

// The product page behind the dialog. Lazy, so a volunteer signing in on a phone in a field is not
// made to download a marketing page's font and pictures before the sign-in box works.
const ProductSite = lazy(() => import('../product/ProductSite').then((m) => ({ default: m.ProductSite })));

export function LoginPage() {
  const login = useLogin();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const from = (loc.state as { from?: string } | null)?.from;
  // Sign-in is a modal dialog over the product page. Closing it (Escape, or "Learn about
  // CanvassOS") reveals the page; "Sign in" on the page opens it again.
  const dialog = useRef<HTMLDialogElement>(null);
  const [signInOpen, setSignInOpen] = useState(true);
  const [tourOpen, setTourOpen] = useState(false);
  const waitlistField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (signInOpen && !d.open) d.showModal();
    if (!signInOpen && d.open) d.close();
  }, [signInOpen]);

  const openSignIn = () => {
    setTourOpen(false);
    setSignInOpen(true);
  };
  const startTour = () => {
    setSignInOpen(false);
    setTourOpen(true);
  };
  const joinFromTour = () => {
    setTourOpen(false);
    // After React has closed the tour dialog (an effect) and the page is interactive again; a
    // timeout rather than requestAnimationFrame, which never fires in a background tab.
    setTimeout(() => goToWaitlist(waitlistField), 50);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => nav(from && from !== '/login' ? from : '/map', { replace: true }),
      },
    );
  };

  let error: string | null = null;
  if (login.isError) {
    if (isApiError(login.error, 401)) error = 'That email and password did not match.';
    else if (isApiError(login.error, 429)) error = 'Too many attempts — wait a minute and try again.';
    else error = errorMessage(login.error);
  }

  return (
    <>
      <Suspense fallback={<div className="auth-page" />}>
        <ProductSite onSignIn={openSignIn} onTour={startTour} waitlistField={waitlistField} />
      </Suspense>
      <dialog ref={dialog} className="signin" aria-labelledby="signin-title" onClose={() => setSignInOpen(false)}>
        <form className="card auth-card" onSubmit={onSubmit} noValidate>
          <div className="auth-card__brand">
            <Wordmark />
            <p className="muted">Middlesex Centre voter map</p>
          </div>
          <h1 className="auth-card__title" id="signin-title">
            Sign in
          </h1>
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
          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={login.isPending || !email || !password}
          >
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="muted small auth-card__note">
            Forgotten your password? There is no self-serve reset — ask an organiser to re-invite you, or whoever runs
            the server can issue a link with <code>make reset-password</code>.
          </p>
          <p className="muted small auth-card__note">
            Accounts are by invitation. The voters list is provided under the <em>Municipal Elections Act</em> for
            election purposes only; every sign-in and lookup is logged.
          </p>
          <p className="small signin__learn">
            Not on a campaign yet?{' '}
            <button type="button" className="p-link" onClick={startTour}>
              Learn about CanvassOS
            </button>
          </p>
        </form>
      </dialog>
      <Tour open={tourOpen} onClose={() => setTourOpen(false)} onJoin={joinFromTour} onSignIn={openSignIn} />
    </>
  );
}
