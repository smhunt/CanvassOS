import type { CSSProperties } from 'react';
import type { TurfSummary } from '../api/types';
import { fmtDate, n, wardLabel } from '../components/ui';
import { wardColour } from '../map/palette';
import { STATUS_LABELS, STATUS_TONE } from './status';

interface Props {
  turf: TurfSummary;
  busy: boolean;
  error: string | null;
  onRename: () => void;
  onAssign: () => void;
  onToggleArchive: () => void;
}

export function TurfCard({ turf, busy, error, onRename, onAssign, onToggleArchive }: Props) {
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
          turf.assignees.map((a) => (
            <span key={a.user_id} className={`tag tag--mini tag--${STATUS_TONE[a.status]}`}>
              {a.name} — {STATUS_LABELS[a.status]}
            </span>
          ))
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
          Assign
        </button>
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
