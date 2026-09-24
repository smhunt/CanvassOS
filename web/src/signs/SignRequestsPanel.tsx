/**
 * The delivery run, in two halves.
 *
 * The first is doors that asked at the door: derived from the last canvass contact's `wants_sign`.
 * Unlike the rest of the signs screens this IS voter data — addresses off the list, with what the
 * resident said — so it is scoped server-side (a volunteer sees only their own turfs) and every
 * load is audited. Nothing here is exported or copyable in bulk on purpose.
 *
 * The second half (`AskedRequestsPanel`, organizer/admin only) is everything that arrived some
 * other way: phoned in, texted, or signed up on the website. Those are `public_request` rows and
 * carry contact details, which is why a volunteer never sees that half.
 *
 * A door drops off the first list the moment a sign is recorded against it, which is why "Place a
 * sign here" carries the household id through to the placing tab.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useMe, useSignRequests } from '../api/hooks';
import { HouseholdActions } from '../canvass/HouseholdActions';
import { EmptyState, ErrorBox, LoadingCards, fmtDate, n, titleCase, wardLabel } from '../components/ui';
import { wardColour } from '../map/palette';
import { relativeDay } from '../reports/relative';
import { AskedRequestsPanel } from './AskedRequestsPanel';
import { toDeliveryRequests, type DeliveryRequest } from './rows';

export function SignRequestsPanel() {
  const me = useMe();
  const organizer = me.data?.role === 'organizer' || me.data?.role === 'admin';

  return (
    <>
      <DoorRequests />
      {organizer && <AskedRequestsPanel />}
    </>
  );
}

/** Doors off the voters list whose last contact ticked "wants a lawn sign". */
function DoorRequests() {
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
    <section aria-labelledby="sg-doors-h">
      <h2 id="sg-doors-h" className="sheet__h3">
        Asked at the door
      </h2>
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
    </section>
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
        {/* "Place a sign here" stays the primary button: on this list, delivering one is the job.
            The shared set follows it so this screen offers the same actions as everywhere else —
            "Request a sign" will be disabled here, because this door already has. */}
        <Link
          className="btn btn--small btn--primary"
          to={`/signs?tab=place&household=${encodeURIComponent(r.household_id)}&address=${encodeURIComponent(r.address)}`}
        >
          Place a sign here
        </Link>
        <HouseholdActions
          door={{ id: r.household_id, address: r.address, lat: r.lat, lon: r.lon, turfId: null }}
          provided={['place']}
        />
        {/* /map consumes ?household= and opens straight onto the door card. */}
        <Link className="btn btn--small" to={`/map?household=${encodeURIComponent(r.household_id)}`}>
          Show on the map
        </Link>
      </div>
    </li>
  );
}
