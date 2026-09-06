import { useState, type FormEvent } from 'react';
import { isApiError } from '../api/client';
import { useAssignTurf, useUnassignTurf, useUsers } from '../api/hooks';
import type { TurfSummary } from '../api/types';
import { ErrorBox, LoadingRows } from '../components/ui';
import { AssigneeList, type Assignee } from './AssigneeList';
import { Dialog } from './Dialog';

const ADD_FORM_ID = 'assign-turf-form';
const MOVE_FORM_ID = 'move-turf-form';
/** The confirm button sits in the dialog footer, away from the sentence that explains the effect. */
const REMOVE_EFFECT_ID = 'remove-assignee-effect';

/** Which of the three things this dialog does is on screen. Callers can open straight into any. */
export type AssignStep = { kind: 'list' } | { kind: 'remove'; userId: string } | { kind: 'move'; userId: string };

interface Props {
  turf: TurfSummary;
  initialStep?: AssignStep;
  onClose: () => void;
}

/**
 * One dialog for the whole life of an assignment: hand a turf out, take it back, or move it to
 * someone else. Moving is two API calls but one decision, so it is one button and one confirmation.
 */
export function AssignDialog({ turf, initialStep, onClose }: Props) {
  const users = useUsers();
  const assign = useAssignTurf();
  const unassign = useUnassignTurf();
  const [step, setStep] = useState<AssignStep>(initialStep ?? { kind: 'list' });
  const [userId, setUserId] = useState('');
  /** Set only when a move half-landed; describes the state the turf is actually in. */
  const [partial, setPartial] = useState<string | null>(null);

  const already = new Set(turf.assignees.map((a) => a.user_id));
  const candidates = (users.data ?? []).filter((u) => u.active && !u.invite_pending).sort((a, b) => a.name.localeCompare(b.name));
  const busy = assign.isPending || unassign.isPending;

  // The turf list refetches underneath this dialog. If the person we were about to act on is gone
  // already — another organiser, or our own retry landing — fall back to the list rather than
  // confirming something that has happened.
  const target = step.kind === 'list' ? undefined : turf.assignees.find((a) => a.user_id === step.userId);
  const view = target ? step.kind : 'list';

  const goList = () => {
    setStep({ kind: 'list' });
    setUserId('');
    setPartial(null);
    assign.reset();
    unassign.reset();
  };

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    if (!userId || busy) return;
    assign.mutate({ turfId: turf.id, userId }, { onSuccess: onClose });
  };

  const onRemove = async () => {
    if (!target || busy) return;
    unassign.reset();
    try {
      await unassign.mutateAsync({ turfId: turf.id, userId: target.user_id });
    } catch {
      return; // The mutation's own error state renders below; `partial`, if set, still holds.
    }
    onClose();
  };

  const onMove = async (e: FormEvent) => {
    e.preventDefault();
    const from = target;
    if (!from || !userId || busy) return;
    setPartial(null);
    assign.reset();
    unassign.reset();
    // Assign before unassign: if only one call lands, a turf with one person too many is fixable in
    // a tap, while an unassign alone leaves doors with nobody walking them and nobody told.
    try {
      await assign.mutateAsync({ turfId: turf.id, userId });
    } catch {
      return;
    }
    try {
      await unassign.mutateAsync({ turfId: turf.id, userId: from.user_id });
    } catch {
      // Half a move is the one outcome we must not report as a move.
      const to = candidates.find((u) => u.id === userId)?.name ?? 'The new volunteer';
      setPartial(
        `${to} now has this turf, but ${from.name} could not be taken off it — both of them have it until you remove ${from.name}.`,
      );
      setStep({ kind: 'remove', userId: from.user_id });
      return;
    }
    onClose();
  };

  // /api/users needs organizer rights, so someone can reach this dialog without being able to list
  // people. Taking a turf back does not need the list, so only the add and move steps are blocked.
  const forbidden = users.isError && isApiError(users.error, 403);

  const title =
    view === 'remove' && target
      ? `Remove ${target.name} from “${turf.name}”`
      : view === 'move' && target
        ? `Move “${turf.name}” to someone else`
        : `Assign “${turf.name}”`;

  const footer =
    view === 'remove' && target ? (
      <>
        <button type="button" className="btn" onClick={goList}>
          Keep {target.name} on it
        </button>
        <button
          type="button"
          className="btn btn--danger-outline"
          aria-describedby={REMOVE_EFFECT_ID}
          onClick={() => void onRemove()}
          disabled={busy}
        >
          {unassign.isPending ? 'Removing…' : `Remove ${target.name}`}
        </button>
      </>
    ) : view === 'move' ? (
      <>
        <button type="button" className="btn" onClick={goList}>
          Cancel
        </button>
        <button type="submit" form={MOVE_FORM_ID} className="btn btn--primary" disabled={!userId || busy}>
          {busy ? 'Moving…' : 'Move turf'}
        </button>
      </>
    ) : (
      <>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
        <button type="submit" form={ADD_FORM_ID} className="btn btn--primary" disabled={!userId || busy}>
          {assign.isPending ? 'Assigning…' : 'Assign'}
        </button>
      </>
    );

  return (
    <Dialog
      title={title}
      titleId="assign-turf-h"
      onClose={onClose}
      focusKey={`${view}:${target?.user_id ?? ''}`}
      footer={footer}
    >
      <div className="modal__body">
        {partial && (
          <div className="alert alert--warn" role="alert">
            <div>
              <strong>The move only half happened</strong>
              <div className="alert__detail">{partial}</div>
            </div>
          </div>
        )}

        {view === 'remove' && target && (
          <div className="confirm">
            <p className="confirm__lead">
              {target.name} loses “{turf.name}” from “My turfs” and can no longer open its doors.
            </p>
            {/* Organisers read “remove” as “delete their work”. It is not, and saying so here is the
                difference between them acting and them phoning to ask. */}
            <p className="confirm__effect small" id={REMOVE_EFFECT_ID}>
              Everything {target.name} already recorded stays exactly where it is — contacts are only ever added,
              never deleted, so the turf keeps its progress for whoever walks it next.
            </p>
            {unassign.isError && <ErrorBox title={`Could not remove ${target.name}`} error={unassign.error} compact />}
          </div>
        )}

        {view === 'move' && target && (
          <div className="confirm">
            <p className="confirm__lead">
              {target.name} comes off “{turf.name}” and the person you pick takes it on. Their doors, and anything{' '}
              {target.name} already recorded, stay on the turf.
            </p>
            {users.isPending && <LoadingRows rows={2} />}
            {forbidden && (
              <div className="alert alert--warn" role="alert">
                Your account cannot list people, so it cannot move a turf — ask an admin, or remove {target.name} and
                let them assign it.
              </div>
            )}
            {users.isError && !forbidden && <ErrorBox error={users.error} onRetry={() => void users.refetch()} compact />}
            {users.data && (
              <form id={MOVE_FORM_ID} onSubmit={(e) => void onMove(e)}>
                <div className="field">
                  <label className="field__label" htmlFor="move-to">
                    Move to
                  </label>
                  <select id="move-to" aria-describedby="move-to-hint" value={userId} onChange={(e) => setUserId(e.target.value)}>
                    <option value="">Choose someone…</option>
                    {candidates.map((u) => (
                      <option key={u.id} value={u.id} disabled={already.has(u.id)}>
                        {u.name} ({u.role}){already.has(u.id) ? ' — already assigned' : ''}
                      </option>
                    ))}
                  </select>
                  <span className="field__hint" id="move-to-hint">
                    Done as two steps — the new volunteer is added first, then {target.name} is taken off.
                  </span>
                </div>
              </form>
            )}
            {assign.isError && (
              <>
                <ErrorBox title="Could not move the turf" error={assign.error} compact />
                {/* The move is ordered so this failure changes nothing — say so, or they retry blind. */}
                <p className="muted small">Nothing changed — {target.name} still has this turf.</p>
              </>
            )}
          </div>
        )}

        {view === 'list' && (
          <>
            <section className="assign__section">
              <h3>Assigned now</h3>
              {turf.assignees.length === 0 ? (
                <p className="muted small">Nobody yet.</p>
              ) : (
                <AssigneeList
                  assignees={turf.assignees}
                  turfName={turf.name}
                  busy={busy}
                  onMove={(a: Assignee) => {
                    setUserId('');
                    setStep({ kind: 'move', userId: a.user_id });
                  }}
                  onRemove={(a: Assignee) => setStep({ kind: 'remove', userId: a.user_id })}
                />
              )}
            </section>

            {users.isPending && <LoadingRows rows={2} />}
            {forbidden && (
              <div className="alert alert--warn" role="alert">
                Your account cannot list users — ask an admin to make the assignment.
              </div>
            )}
            {users.isError && !forbidden && <ErrorBox error={users.error} onRetry={() => void users.refetch()} compact />}

            {users.data && (
              <form id={ADD_FORM_ID} onSubmit={onAdd}>
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
                    They will see this turf under “My turfs” with its doors in walking order. A turf can hold more than
                    one walker — a long road is often split between two.
                  </span>
                </div>
              </form>
            )}

            {assign.isError && <ErrorBox title="Could not assign the turf" error={assign.error} compact />}
            {unassign.isError && <ErrorBox title="Could not remove that volunteer" error={unassign.error} compact />}
          </>
        )}
      </div>
    </Dialog>
  );
}
