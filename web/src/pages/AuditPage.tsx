import { useState } from 'react';
import { useAudit, useUsers } from '../api/hooks';
import type { AuditEntry } from '../api/types';
import { EmptyState, ErrorBox, LoadingTable, fmtDate } from '../components/ui';

const ACTIONS = [
  'login',
  'login_failed',
  'logout',
  'view_household',
  'search',
  'invite',
  'reinvite',
  'accept_invite',
  'update_user',
  'change_password',
  'export',
];

function detailText(e: AuditEntry): string {
  if (e.detail === null || e.detail === undefined) return '';
  if (typeof e.detail === 'string') return e.detail;
  if (typeof e.detail === 'object') {
    return Object.entries(e.detail as Record<string, unknown>)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ');
  }
  return String(e.detail);
}

export function AuditPage() {
  const users = useUsers();
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');
  const audit = useAudit({ user_id: userId, action });
  const entries = audit.data?.pages.flat() ?? [];

  return (
    <div className="page">
      <header className="page__head">
        <h1>Audit log</h1>
        <p className="muted">
          Every sign-in, household view, search, invite and user change. Required under the <em>Municipal Elections Act</em> to show the
          list was handled properly.
        </p>
      </header>

      <section className="card">
        <div className="form-row form-row--filters">
          <label className="field">
            <span className="field__label">User</span>
            <select aria-label="User" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Everyone</option>
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Action</span>
            <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">All actions</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" onClick={() => void audit.refetch()} disabled={audit.isFetching}>
            {audit.isFetching && !audit.isFetchingNextPage ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {audit.isPending && <LoadingTable rows={8} cols={5} label="Loading the audit log…" />}
        {audit.isError && <ErrorBox error={audit.error} onRetry={() => void audit.refetch()} compact />}
        {audit.data && entries.length === 0 && <EmptyState title="No matching audit entries" />}
        {entries.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="table table--compact audit">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">User</th>
                    <th scope="col">Action</th>
                    <th scope="col">Target / detail</th>
                    <th scope="col">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="nowrap muted small">{fmtDate(e.at)}</td>
                      <td>
                        {e.user_name ?? <span className="muted">—</span>}
                        {e.user_email && <div className="muted small">{e.user_email}</div>}
                      </td>
                      <td>
                        <span className={`tag tag--mini tag--act-${e.action}`}>{e.action}</span>
                      </td>
                      <td className="small">
                        {e.target && <span className="mono">{e.target}</span>}
                        {e.target && detailText(e) && ' · '}
                        <span className="muted">{detailText(e)}</span>
                      </td>
                      <td className="mono small muted">{e.ip ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row row--center">
              {audit.hasNextPage ? (
                <button type="button" className="btn" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
                  {audit.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
                </button>
              ) : (
                <span className="muted small">End of log · {entries.length} entries shown</span>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
