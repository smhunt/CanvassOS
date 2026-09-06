import { Link } from 'react-router-dom';
import type { CSSProperties } from 'react';
import type { TurfSummary } from '../api/types';
import { fmtDate, n, wardLabel } from '../components/ui';
import { wardColour } from '../map/palette';
import { AssigneeList, type Assignee } from './AssigneeList';

interface Props {
  turf: TurfSummary;
  busy: boolean;
  error: string | null;
  onRename: () => void;
  onAssign: () => void;
  onMoveAssignee: (a: Assignee) => void;
  onRemoveAssignee: (a: Assignee) => void;
  onToggleArchive: () => void;
}

export function TurfCard({
  turf,
  busy,
  error,
  onRename,
  onAssign,
  onMoveAssignee,
  onRemoveAssignee,
  onToggleArchive,
}: Props) {
  const pct = turf.n_households > 0 ? Math.round((turf.contacted / turf.n_households) * 100) : 0;
  const colour = wardColour(turf.ward ?? '');

  return (
    <li className={`card turf${turf.archived ? ' turf--archived' : ''}`} style={{ '--ward': colour } as CSSProperties}>
      <div className="turf__head">
        <h3 className="turf__name">{turf.name}</h3>
        <span className="turf__ward">{turf.ward ? wardLabel(turf.ward) : 'All wards'}</span>
      </div>

      <p className="turf__counts">
        <strong>{n(turf.streets.length)}</strong> street{turf.streets.length === 1 ? '' : 's'} ·{' '}
        <strong>{n(turf.n_households)}</strong> doors · <strong>{n(turf.n_voters)}</strong> voters
      </p>

      <div
        className="turf__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={turf.n_households || 1}
        aria-valuenow={turf.contacted}
        aria-valuetext={`${n(turf.contacted)} of ${n(turf.n_households)} doors contacted`}
        aria-label={`Progress on ${turf.name}`}
      >
        <span className="turf__bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="turf__progress small">
        {n(turf.contacted)} of {n(turf.n_households)} doors contacted <span className="muted">({pct}%)</span>
      </p>

      <div className="turf__assignees">
        {turf.assignees.length === 0 ? (
          <span className="tag tag--mini tag--neutral">Unassigned</span>
        ) : (
          <AssigneeList
            assignees={turf.assignees}
            turfName={turf.name}
            busy={busy}
            onMove={onMoveAssignee}
            onRemove={onRemoveAssignee}
          />
        )}
      </div>

      <p className="muted small turf__meta">
        Created {fmtDate(turf.created_at, false)}
        {turf.created_by_name && ` by ${turf.created_by_name}`}
      </p>

      {error && (
        <div className="alert alert--danger alert--compact" role="alert">
          {error}
        </div>
      )}

      <div className="turf__actions">
        <button type="button" className="btn btn--small" disabled={busy} onClick={onAssign}>
          {turf.assignees.length > 0 ? 'Assign another' : 'Assign'}
        </button>
        {/* Where is it? The card has counts but no geography; the main map fits itself to `?turf=`.
            Labelled with the turf name because a list of cards is a list of identical links. */}
        <Link className="btn btn--small" to={`/map?turf=${turf.id}`} aria-label={`Show ${turf.name} on the map`}>
          Show on map
        </Link>
        {/* The paper fallback for a dead battery, no signal or rain. */}
        <Link className="btn btn--small" to={`/turfs/${turf.id}/sheet`}>
          Print sheet
        </Link>
        <button type="button" className="btn btn--small" disabled={busy} onClick={onRename}>
          Rename
        </button>
        <button
          type="button"
          className={`btn btn--small${turf.archived ? '' : ' btn--danger-outline'}`}
          disabled={busy}
          onClick={onToggleArchive}
        >
          {turf.archived ? 'Unarchive' : 'Archive'}
        </button>
      </div>
    </li>
  );
}
