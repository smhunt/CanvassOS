import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorMessage, isApiError } from '../api/client';
import { useChangePassword, useLogout, useMeta } from '../api/hooks';
import { PasswordField } from '../components/PasswordField';
import { APP_VERSION, ChangelogModal, REPO_URL, type AboutTab } from '../components/changelog-modal';
import { useUser } from '../components/Shell';
import { LoadingRows, RoleChip, fmtDate, n } from '../components/ui';

const MIN_PASSWORD = 10;

export function AccountPage() {
  const user = useUser();
  const meta = useMeta();
  const logout = useLogout();
  const change = useChangePassword();
  const nav = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [about, setAbout] = useState<AboutTab | null>(null);

  const tooShort = next.length > 0 && next.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== next;
  const valid = current.length > 0 && next.length >= MIN_PASSWORD && confirm === next;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || change.isPending) return;
    setDone(false);
    change.mutate(
      { current, next },
      {
        onSuccess: () => {
          setDone(true);
          setCurrent('');
          setNext('');
          setConfirm('');
        },
      },
    );
  };

  let error: string | null = null;
  if (change.isError) {
    if (isApiError(change.error) && change.error.code === 'wrong_password') error = 'Your current password is incorrect.';
    else if (isApiError(change.error) && change.error.code === 'same_password') error = 'The new password must differ from the current one.';
    else error = errorMessage(change.error);
  }

  return (
    <div className="page page--narrow">
      <header className="page__head">
        <h1>Account</h1>
      </header>

      <section className="card">
        <div className="row row--between">
          <div>
            <div className="cell-name">{user.name}</div>
            <div className="muted">{user.email}</div>
          </div>
          <RoleChip role={user.role} />
        </div>
        <button
          type="button"
          className="btn"
          disabled={logout.isPending}
          onClick={() => logout.mutate(undefined, { onSettled: () => nav('/login', { replace: true }) })}
        >
          {logout.isPending ? 'Signing out…' : 'Sign out'}
        </button>
      </section>

      <section className="card" aria-labelledby="pw-h">
        <h2 id="pw-h">Change password</h2>
        <p className="muted small">Changing your password signs out every other device.</p>
        <form onSubmit={onSubmit} noValidate className="stack">
          <PasswordField
            label="Current password"
            name="current"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
            required
          />
          <PasswordField
            label="New password"
            name="next"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            invalid={tooShort}
            hint={`At least ${MIN_PASSWORD} characters.`}
          />
          <PasswordField
            label="Confirm new password"
            name="confirm"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            required
            invalid={mismatch}
            hint={mismatch ? 'Passwords do not match.' : undefined}
          />
          {error && (
            <div className="alert alert--danger" role="alert">
              {error}
            </div>
          )}
          {done && (
            <div className="alert alert--ok" role="status">
              Password changed.
            </div>
          )}
          <div>
            <button type="submit" className="btn btn--primary" disabled={!valid || change.isPending}>
              {change.isPending ? 'Saving…' : 'Change password'}
            </button>
          </div>
        </form>
      </section>

      <section className="card" aria-labelledby="data-h">
        <h2 id="data-h">Data</h2>
        {meta.isPending && <LoadingRows rows={4} label="Loading the import details…" />}
        {meta.isError && <p className="muted">Import details unavailable.</p>}
        {meta.data?.import ? (
          <dl className="dl">
            <dt>Source</dt>
            <dd>{meta.data.import.source_label}</dd>
            <dt>Imported</dt>
            <dd>{fmtDate(meta.data.import.finished_at)}</dd>
            <dt>Households</dt>
            <dd>{n(meta.data.import.n_households)}</dd>
            <dt>Voters</dt>
            <dd>{n(meta.data.import.n_voters)}</dd>
          </dl>
        ) : (
          meta.data && <p className="muted">No import has been recorded yet.</p>
        )}
        <p className="muted small">
          The voters list is personal information supplied under the Ontario <em>Municipal Elections Act</em>. Use it for this campaign
          only, keep it confidential, and expect every lookup to be logged. It is destroyed after the election.
        </p>
      </section>

      <section className="card" aria-labelledby="about-app-h">
        <div className="row row--between">
          <h2 id="about-app-h">About this app</h2>
          <span className="tag tag--neutral mono">v{APP_VERSION}</span>
        </div>
        <p className="muted small">CanvassOS — Phase 1: the voters list, the map and the numbers. Canvassing itself lands in Phase 2.</p>
        <div className="row">
          <button type="button" className="btn btn--small" onClick={() => setAbout('changelog')}>
            Changelog
          </button>
          <button type="button" className="btn btn--small" onClick={() => setAbout('how')}>
            How it works
          </button>
          <button type="button" className="btn btn--small" onClick={() => setAbout('roadmap')}>
            Roadmap
          </button>
          <a className="btn btn--small" href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
      </section>

      <ChangelogModal open={about !== null} tab={about ?? 'changelog'} onTab={setAbout} onClose={() => setAbout(null)} />
    </div>
  );
}
