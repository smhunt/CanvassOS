import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useFollowUps } from '../api/hooks';
import { RESULT_LABELS, type FollowUp } from '../api/types';
import { EmptyState, ErrorBox, LoadingRows, fmtDate, n, titleCase, wardLabel } from '../components/ui';
import { RESULT_COLOURS, wardColour } from '../map/palette';
import { relativeDay } from './relative';

/**
 * The worklist of doors whose most recent contact asked for a follow-up. Ordered newest first —
 * a promise made yesterday is the one most likely to still be worth keeping.
 */
export function FollowUpQueue() {
  const followUps = useFollowUps();
  const [ward, setWard] = useState('');

  const rows = useMemo(() => followUps.data ?? [], [followUps.data]);

  const wards = useMemo(() => [...new Set(rows.map((f) => f.ward))].sort(), [rows]);

  const shown = useMemo(() => {
    const filtered = ward ? rows.filter((f) => f.ward === ward) : rows;
    // The API already sorts, but the queue is worthless if a stale cache or a future filter
    // reorders it, so make "newest first" a property of this component.
    return [...filtered].sort((a, b) => b.last_contact_at.localeCompare(a.last_contact_at));
  }, [rows, ward]);

  if (followUps.isPending) {
    return (
      <div className="card">
        <LoadingRows rows={5} />
      </div>
    );
  }
  if (followUps.isError) {
    return <ErrorBox title="Could not load the follow-up queue" error={followUps.error} onRetry={() => void followUps.refetch()} />;
  }

  return (
    <>
      <div className="rep-toolbar">
        <label className="select-pill">
          <span className="visually-hidden">Filter by ward</span>
          <select value={ward} onChange={(e) => setWard(e.target.value)} aria-label="Filter follow-ups by ward">
            <option value="">All wards</option>
            {wards.map((w) => (
              <option key={w} value={w}>
                {wardLabel(w)}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small rep-toolbar__count" aria-live="polite">
          {n(shown.length)} {shown.length === 1 ? 'door' : 'doors'}
          {ward && ` in ${wardLabel(ward)}`}
        </p>
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <EmptyState title={ward ? `No doors are flagged for follow-up in ${wardLabel(ward)}.` : 'No doors are flagged for follow-up.'}>
            {ward ? <p>Clear the ward filter to see the rest of the queue.</p> : <p>A door lands here when a canvasser ticks “follow up” on the door screen.</p>}
          </EmptyState>
        </div>
      ) : (
        <ul className="rep-queue">
          {shown.map((f) => (
            <FollowUpRow key={f.household_id} f={f} />
          ))}
        </ul>
      )}
    </>
  );
}

function FollowUpRow({ f }: { f: FollowUp }) {
  return (
    <li className="card rep-fu" style={{ '--ward': wardColour(f.ward) } as CSSProperties}>
      <div className="rep-fu__head">
        <h3 className="rep-fu__addr">{f.address}</h3>
        <div className="rep-fu__where">
          <span className="tag" style={{ '--tag': wardColour(f.ward) } as CSSProperties}>
            {wardLabel(f.ward)}
          </span>
          {f.community && <span className="chip">{titleCase(f.community)}</span>}
        </div>
      </div>

      <div className="rep-fu__meta">
        <span className="tag tag--mini" style={{ '--tag': RESULT_COLOURS[f.last_result] } as CSSProperties}>
          {RESULT_LABELS[f.last_result]}
        </span>
        <span className="muted small">
          {relativeDay(f.last_contact_at)} · {fmtDate(f.last_contact_at)}
          {f.user_name && ` · by ${f.user_name}`}
        </span>
      </div>

      {f.note ? (
        <p className="rep-fu__note">{f.note}</p>
      ) : (
        <p className="rep-fu__note rep-fu__note--none">No note was left with the flag.</p>
      )}

      <div className="rep-fu__actions">
        {/* /map consumes ?household= and opens straight onto the door card. */}
        <Link className="btn btn--small" to={`/map?household=${encodeURIComponent(f.household_id)}`}>
          Show this door on the map
        </Link>
      </div>
    </li>
  );
}
