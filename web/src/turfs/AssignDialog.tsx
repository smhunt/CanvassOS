import { useState, type FormEvent } from 'react';
import { isApiError } from '../api/client';
import { useAssignTurf, useUsers } from '../api/hooks';
import type { TurfSummary } from '../api/types';
import { ErrorBox, LoadingRows } from '../components/ui';
import { Dialog } from './Dialog';
import { STATUS_LABELS, STATUS_TONE } from './status';

const FORM_ID = 'assign-turf-form';

interface Props {
  turf: TurfSummary;
  onClose: () => void;
}

export function AssignDialog({ turf, onClose }: Props) {
  const users = useUsers();
  const assign = useAssignTurf();
  const [userId, setUserId] = useState('');

  const already = new Set(turf.assignees.map((a) => a.user_id));
  const candidates = (users.data ?? []).filter((u) => u.active && !u.invite_pending).sort((a, b) => a.name.localeCompare(b.name));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!userId || assign.isPending) return;
    assign.mutate({ turfId: turf.id, userId }, { onSuccess: onClose });
  };

  // /api/users is admin-only, so an organizer can reach this dialog without being able to list people.
  const forbidden = users.isError && isApiError(users.error, 403);

  return (
    <Dialog
      title={`Assign “${turf.name}”`}
      titleId="assign-turf-h"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn btn--primary" disabled={!userId || assign.isPending}>
            {assign.isPending ? 'Assigning…' : 'Assign'}
          </button>
        </>
      }
    >
      <div className="modal__body">
        <h3>Already assigned</h3>
        {turf.assignees.length === 0 ? (
          <p className="muted small">Nobody yet.</p>
        ) : (
          <ul className="assignees">
            {turf.assignees.map((a) => (
              <li key={a.user_id}>
                {a.name} <span className={`tag tag--mini tag--${STATUS_TONE[a.status]}`}>{STATUS_LABELS[a.status]}</span>
              </li>
            ))}
          </ul>
        )}

        {users.isPending && <LoadingRows rows={2} />}
        {forbidden && (
          <div className="alert alert--warn" role="alert">
            Your account cannot list users — ask an admin to make the assignment.
          </div>
        )}
        {users.isError && !forbidden && <ErrorBox error={users.error} onRetry={() => void users.refetch()} compact />}

        {users.data && (
          <form id={FORM_ID} onSubmit={onSubmit}>
            <div className="field">
              <label className="field__label" htmlFor="assign-to">
                Assign to
              </label>
              <select id="assign-to" aria-describedby="assign-to-hint" value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Choose someone…</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id} disabled={already.has(u.id)}>
                    {u.name} ({u.role}){already.has(u.id) ? ' — already assigned' : ''}
                  </option>
                ))}
              </select>
              <span className="field__hint" id="assign-to-hint">
                They will see this turf under “My turfs” with its doors in walking order.
              </span>
            </div>
          </form>
        )}

        {assign.isError && <ErrorBox title="Could not assign the turf" error={assign.error} compact />}
      </div>
    </Dialog>
  );
}
