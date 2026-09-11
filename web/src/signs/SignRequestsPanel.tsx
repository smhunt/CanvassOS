/**
 * The delivery run: doors that asked for a sign at the door and have not had one yet.
 *
 * Unlike the rest of the signs screens this IS voter data — addresses off the list, with what the
 * resident said — so it is scoped server-side (a volunteer sees only their own turfs) and every
 * load is audited. Nothing here is exported or copyable in bulk on purpose.
 *
 * A door drops off this list the moment a sign is recorded against it, which is why "Place a sign
 * here" carries the household id through to the placing tab.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useSignRequests } from '../api/hooks';
import { EmptyState, ErrorBox, LoadingCards, fmtDate, n, titleCase, wardLabel } from '../components/ui';
import { wardColour } from '../map/palette';
import { relativeDay } from '../reports/relative';
import { toDeliveryRequests, type DeliveryRequest } from './rows';

export function SignRequestsPanel() {
  const requests = useSignRequests();
  const [ward, setWard] = useState('');

  const rows = useMemo(() => toDeliveryRequests(requests.data), [requests.data]);
  const wards = useMemo(() => [...new Set(rows.map((r) => r.ward).filter(Boolean))].sort(), [rows]);
  const shown = useMemo(() => (ward ? rows.filter((r) => r.ward === ward) : rows), [rows, ward]);

  if (requests.isPending) {
    return <LoadingCards count={4} label="Loading the sign requests…" />;
  }
  if (requests.isError) {
    return <ErrorBox title="Could not load the sign requests" error={requests.error} onRetry={() => void requests.refetch()} />;
  }

  return (
    <>
      <div className="sg-toolbar">
        {wards.length > 1 && (
          <label className="select-pill">
            <span className="visually-hidden">Filter by ward</span>
            <select value={ward} onChange={(e) => setWard(e.target.value)} aria-label="Filter sign requests by ward">
              <option value="">All wards</option>
              {wards.map((w) => (
                <option key={w} value={w}>
                  {wardLabel(w)}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="muted small sg-toolbar__count" aria-live="polite">
          {n(shown.length)} {shown.length === 1 ? 'door waiting' : 'doors waiting'}
          {ward && ` in ${wardLabel(ward)}`}
        </p>
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <EmptyState title={ward ? `No sign requests outstanding in ${wardLabel(ward)}.` : 'No sign requests outstanding.'}>
            <p>A door lands here when a canvasser ticks “wants a sign” on the door screen, and drops off as soon as a sign is recorded against it.</p>
          </EmptyState>
        </div>
      ) : (
        <ul className="sg-list">
          {shown.map((r) => (
            <RequestRow key={r.household_id} r={r} />
          ))}
        </ul>
      )}
    </>
  );
}

function RequestRow({ r }: { r: DeliveryRequest }) {
  return (
    <li className="card sg-row" style={{ '--ward': wardColour(r.ward) } as CSSProperties}>
      <div className="sg-row__head">
        <h3 className="sg-row__title">{r.address}</h3>
        <div className="sg-row__tags">
          {r.ward && (
            <span className="tag" style={{ '--tag': wardColour(r.ward) } as CSSProperties}>
              {wardLabel(r.ward)}
            </span>
          )}
          {r.community && <span className="chip">{titleCase(r.community)}</span>}
        </div>
      </div>

      <p className="muted small sg-row__meta">
        Asked {relativeDay(r.at)} · {fmtDate(r.at)}
        {r.user_name && ` · taken by ${r.user_name}`}
        {r.voter_name && ` · spoke to ${r.voter_name}`}
      </p>

      {r.note ? <p className="sg-note">{r.note}</p> : <p className="sg-note sg-note--none">No note was left at the door.</p>}

      <div className="sg-row__actions">
        <Link
          className="btn btn--small btn--primary"
          to={`/signs?tab=place&household=${encodeURIComponent(r.household_id)}&address=${encodeURIComponent(r.address)}`}
        >
          Place a sign here
        </Link>
        {/* /map consumes ?household= and opens straight onto the door card. */}
        <Link className="btn btn--small" to={`/map?household=${encodeURIComponent(r.household_id)}`}>
          Show on the map
        </Link>
      </div>
    </li>
  );
}
