import { useRef, useState, type FormEvent } from 'react';
import { errorMessage, isApiError } from '../api/client';
import { useInviteUser, useReinviteUser, useUpdateUser, useUsers } from '../api/hooks';
import type { Role, UserRow } from '../api/types';
import { useUser } from '../components/Shell';
import { EmptyState, ErrorBox, LoadingRows, RoleChip, fmtDate } from '../components/ui';

const ROLES: Role[] = ['volunteer', 'organizer', 'admin'];

export function UsersPage() {
  const me = useUser();
  const users = useUsers();
  const invite = useInviteUser();
  const reinvite = useReinviteUser();
  const update = useUpdateUser();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('volunteer');
  const [inviteUrl, setInviteUrl] = useState<{ email: string; url: string } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const onInvite = (e: FormEvent) => {
    e.preventDefault();
    if (invite.isPending) return;
    invite.mutate(
      { email: email.trim(), name: name.trim(), role },
      {
        onSuccess: (r) => {
          setInviteUrl({ email: r.user.email, url: r.invite_url });
          setEmail('');
          setName('');
          setRole('volunteer');
        },
      },
    );
  };

  const onReinvite = (u: UserRow) => {
    setRowError(null);
    setBusyId(u.id);
    reinvite.mutate(u.id, {
      onSuccess: (r) => setInviteUrl({ email: u.email, url: r.invite_url }),
      onError: (err) => setRowError({ id: u.id, msg: errorMessage(err) }),
      onSettled: () => setBusyId(null),
    });
  };

  const onPatch = (u: UserRow, body: { role?: Role; active?: boolean }) => {
    setRowError(null);
    setBusyId(u.id);
    update.mutate(
      { id: u.id, ...body },
      {
        onError: (err) =>
          setRowError({
            id: u.id,
            msg: isApiError(err) && err.code === 'last_admin' ? 'That is the last active admin — promote someone else first.' : errorMessage(err),
          }),
        onSettled: () => setBusyId(null),
      },
    );
  };

  let inviteError: string | null = null;
  if (invite.isError) {
    inviteError = isApiError(invite.error, 409) ? 'A user with that email already exists.' : errorMessage(invite.error);
  }

  return (
    <div className="page">
      <header className="page__head">
        <h1>Users</h1>
        <p className="muted">
          Invite links are valid for 7 days and single-use. There is no email service — copy the link and send it yourself
          (Signal, text, email). “Re-invite” issues a fresh link and doubles as a password reset.
        </p>
      </header>

      <section className="card" aria-labelledby="invite-h">
        <h2 id="invite-h">Invite someone</h2>
        <form className="form-row" onSubmit={onInvite} noValidate>
          <label className="field">
            <span className="field__label">Email</span>
            <input type="email" required inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Name</span>
            <input type="text" required autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field field--short">
            <span className="field__label">Role</span>
            <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn--primary" disabled={invite.isPending || !email.trim() || !name.trim()}>
            {invite.isPending ? 'Inviting…' : 'Create invite'}
          </button>
        </form>
        {inviteError && (
          <div className="alert alert--danger" role="alert">
            {inviteError}
          </div>
        )}
        {inviteUrl && <InviteLink email={inviteUrl.email} url={inviteUrl.url} onDismiss={() => setInviteUrl(null)} />}
      </section>

      <section className="card" aria-labelledby="users-h">
        <h2 id="users-h">
          Accounts {users.data && <span className="muted">({users.data.length})</span>}
        </h2>
        {users.isPending && <LoadingRows rows={4} />}
        {users.isError && <ErrorBox error={users.error} onRetry={() => void users.refetch()} compact />}
        {users.data && users.data.length === 0 && <EmptyState title="No users yet" />}
        {users.data && users.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">User</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last sign-in</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => {
                  const self = u.id === me.id;
                  const busy = busyId === u.id;
                  return (
                    <tr key={u.id} className={u.active ? '' : 'row--inactive'}>
                      <td>
                        <div className="cell-name">
                          {u.name} {self && <span className="tag tag--mini tag--neutral">you</span>}
                        </div>
                        <div className="muted small">{u.email}</div>
                        {rowError?.id === u.id && (
                          <div className="alert alert--danger alert--compact" role="alert">
                            {rowError.msg}
                          </div>
                        )}
                      </td>
                      <td>
                        <label className="visually-hidden" htmlFor={`role-${u.id}`}>
                          Role for {u.email}
                        </label>
                        <select
                          id={`role-${u.id}`}
                          className={`select-role select-role--${u.role}`}
                          value={u.role}
                          disabled={busy || self}
                          onChange={(e) => onPatch(u, { role: e.target.value as Role })}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {!u.active ? (
                          <span className="tag tag--mini tag--neutral">deactivated</span>
                        ) : u.invite_pending ? (
                          <span className="tag tag--mini tag--warn">invite pending</span>
                        ) : (
                          <span className="tag tag--mini tag--ok">active</span>
                        )}
                      </td>
                      <td className="muted small">{fmtDate(u.last_login_at)}</td>
                      <td>
                        <div className="cell-actions">
                          <button type="button" className="btn btn--small" disabled={busy || !u.active} onClick={() => onReinvite(u)}>
                            {u.invite_pending ? 'Re-invite' : 'Reset (re-invite)'}
                          </button>
                          <button
                            type="button"
                            className={`btn btn--small${u.active ? ' btn--danger-outline' : ''}`}
                            disabled={busy || self}
                            onClick={() => onPatch(u, { active: !u.active })}
                          >
                            {u.active ? 'Deactivate' : 'Reactivate'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          Roles: <RoleChip role="volunteer" /> map points only · <RoleChip role="organizer" /> cards, search, stats ·{' '}
          <RoleChip role="admin" /> + users and audit.
        </p>
      </section>
    </div>
  );
}

function InviteLink({ email, url, onDismiss }: { email: string; url: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('ok');
    } catch {
      // No clipboard permission (or plain http): select the text so a manual copy is one keystroke.
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopied('fail');
    }
    window.setTimeout(() => setCopied(null), 2500);
  };
  return (
    <div className="alert alert--ok invite-link" role="status">
      <div className="invite-link__text">
        <strong>Invite link for {email}</strong>
        <div className="muted small">Send this to them privately. It works once and expires in 7 days.</div>
        <input ref={inputRef} className="invite-link__url mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite URL" />
      </div>
      <div className="invite-link__actions">
        <button type="button" className="btn btn--primary btn--small" onClick={() => void copy()}>
          {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Selected — press Ctrl/Cmd+C' : 'Copy link'}
        </button>
        <button type="button" className="btn btn--small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
