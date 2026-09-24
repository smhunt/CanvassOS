/**
 * The delivery run: every door waiting for a lawn sign, however it came to be waiting.
 *
 * It used to be two lists stacked on one screen — "asked at the door" above, "asked by phone, text
 * or in person" below — and a volunteer loading a truck had to read both and merge them in their
 * head. They are one list now, newest first, with the origin on a chip because that part does
 * matter: a person who said it on a doorstep and a row off a web form want different handling.
 *
 * FOUR origins, TWO endpoints, and the split between them is a legal boundary, not a tidiness one:
 *
 *   door / direct  →  GET /api/signs/requests   — voter data, volunteer-scoped server-side
 *   manual/website →  GET /api/public/requests  — CASL personal data, organizer/admin at the route
 *
 * The merge happens here, in the browser, for the organizers who may see both. There is no server
 * response in which the two shapes are mixed, so there is no shape in which a volunteer could be
 * handed a name, a phone number or an email. A volunteer sees their own in-turf doors and nothing
 * else — `usePublicRequests` is not even called for them. Do not "simplify" this into one endpoint.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useDeleteManualRequest, useHandleRequest, useMe, usePublicRequests, useSignRequests } from '../api/hooks';
import { HouseholdActions } from '../canvass/HouseholdActions';
import { EmptyState, ErrorBox, LoadingCards, fmtDate, n, titleCase, wardLabel } from '../components/ui';
import { wardColour } from '../map/palette';
import { relativeDay } from '../reports/relative';
import { ManualRequestForm } from './ManualRequestForm';
import {
  ORIGIN_LABELS,
  fromPublicRequests,
  fromSignRequests,
  sortRequests,
  toDeliveryRequests,
  type UnifiedRequest,
} from './rows';

export function SignRequestsPanel() {
  const me = useMe();
  const organizer = me.data?.role === 'organizer' || me.data?.role === 'admin';

  const doors = useSignRequests();
  const publics = usePublicRequests(true, organizer);

  const [ward, setWard] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const rows = useMemo(
    () => sortRequests([...fromSignRequests(toDeliveryRequests(doors.data)), ...fromPublicRequests(publics.data)]),
    [doors.data, publics.data],
  );

  // Only door-derived rows carry a ward, so the filter necessarily hides every phoned-in request
  // while it is set. Said out loud below rather than left for somebody to discover.
  const wards = useMemo(() => [...new Set(rows.map((r) => r.ward).filter((w): w is string => !!w))].sort(), [rows]);
  const shown = useMemo(() => (ward ? rows.filter((r) => r.ward === ward) : rows), [rows, ward]);

  const editing = (publics.data ?? []).find((r) => r.id === editingId) ?? null;
  const pending = doors.isPending || (organizer && publics.isPending);

  return (
    <section aria-labelledby="sg-doors-h">
      <div className="sg-asked__head">
        <h2 id="sg-doors-h" className="sheet__h3">
          Doors waiting for a sign
        </h2>
        {organizer && !adding && !editing && (
          <button type="button" className="btn btn--small btn--primary" onClick={() => setAdding(true)}>
            Add a request
          </button>
        )}
      </div>

      {adding && <ManualRequestForm onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />}
      {editing && (
        <ManualRequestForm editing={editing} onDone={() => setEditingId(null)} onCancel={() => setEditingId(null)} />
      )}

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
          {ward && ` in ${wardLabel(ward)} — phoned-in requests have no ward and are hidden`}
        </p>
      </div>

      {doors.isError && (
        <ErrorBox title="Could not load the sign requests" error={doors.error} onRetry={() => void doors.refetch()} />
      )}
      {organizer && publics.isError && (
        <ErrorBox
          title="Could not load the phoned-in requests"
          error={publics.error}
          onRetry={() => void publics.refetch()}
        />
      )}

      {pending && <LoadingCards count={4} label="Loading the sign requests…" />}

      {!pending && shown.length === 0 && (
        <div className="card">
          <EmptyState title={ward ? `No sign requests outstanding in ${wardLabel(ward)}.` : 'No sign requests outstanding.'}>
            <p>
              A door lands here when a canvasser ticks “wants a sign”, when somebody requests one from a door card, or
              when a request is phoned in or comes off the website. It drops off as soon as a sign is recorded against
              it.
            </p>
          </EmptyState>
        </div>
      )}

      {!pending && shown.length > 0 && (
        <ul className="sg-list">
          {shown.map((r) => (
            <RequestRow key={r.key} r={r} onEdit={() => setEditingId(r.public_request_id)} busy={adding || !!editing} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestRow({ r, onEdit, busy }: { r: UnifiedRequest; onEdit: () => void; busy: boolean }) {
  const remove = useDeleteManualRequest();
  const handle = useHandleRequest();
  const [confirming, setConfirming] = useState(false);

  // Everything the delivery run needs is on the line; the placing form takes it from the query
  // string and PATCHes a public request handled once the sign is actually in the ground. A door
  // row needs no request id — the list it sits on is derived, so a placed sign removes it by itself.
  const placeHref =
    '/signs?tab=place' +
    (r.public_request_id ? `&request=${encodeURIComponent(r.public_request_id)}` : '') +
    (r.household_id ? `&household=${encodeURIComponent(r.household_id)}` : '') +
    `&address=${encodeURIComponent(r.title)}`;

  return (
    <li className="card sg-row" style={r.ward ? ({ '--ward': wardColour(r.ward) } as CSSProperties) : undefined}>
      <div className="sg-row__head">
        <h3 className="sg-row__title">{r.title}</h3>
        <div className="sg-row__tags">
          {r.ward && (
            <span className="tag" style={{ '--tag': wardColour(r.ward) } as CSSProperties}>
              {wardLabel(r.ward)}
            </span>
          )}
          {r.community && <span className="chip">{titleCase(r.community)}</span>}
          <span className="chip">{ORIGIN_LABELS[r.origin]}</span>
          {r.household_id && r.public_request_id && <span className="chip">linked to a door</span>}
        </div>
      </div>

      {/* CASL data, and only ever present on a manual/website row — which only an organizer is
          served. A door row has no contact_line to print. */}
      {r.contact_line && <p className="muted small sg-row__meta">{r.contact_line}</p>}

      <p className="muted small sg-row__meta">
        Asked {relativeDay(r.at)} · {fmtDate(r.at)}
        {r.user_name && ` · taken by ${r.user_name}`}
        {r.voter_name && ` · spoke to ${r.voter_name}`}
      </p>

      {r.note ? <p className="sg-note">{r.note}</p> : <p className="sg-note sg-note--none">No note was left.</p>}

      {remove.isError && <ErrorBox title="Not deleted" error={remove.error} compact />}

      <div className="sg-row__actions">
        {/* Delivering one is the job on this screen, so placing stays the primary button and the
            shared set declares it already provided. */}
        <Link className="btn btn--small btn--primary" to={placeHref}>
          Place a sign here
        </Link>

        <HouseholdActions
          door={
            r.household_id
              ? { id: r.household_id, address: r.title, lat: r.lat, lon: r.lon, turfId: null }
              : null
          }
          provided={['place']}
        />

        {r.public_request_id && r.origin === 'manual' && (
          <>
            <button type="button" className="btn btn--small" onClick={onEdit} disabled={busy}>
              Edit
            </button>
            {confirming ? (
              <>
                <button
                  type="button"
                  className="btn btn--small btn--danger-outline"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(r.public_request_id as string)}
                >
                  Delete for good
                </button>
                <button type="button" className="btn btn--small" onClick={() => setConfirming(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="btn btn--small" onClick={() => setConfirming(true)}>
                Delete
              </button>
            )}
          </>
        )}

        {r.public_request_id && r.origin === 'website' && (
          // A website sign-up is the record of a consent somebody actually gave: not ours to
          // rewrite, and the five-minute sync would re-insert a deleted one by morning.
          <Link className="btn btn--small" to="/requests">
            Open in Sign-ups
          </Link>
        )}

        {r.public_request_id && (
          <button
            type="button"
            className="btn btn--small"
            disabled={handle.isPending}
            onClick={() => handle.mutate({ requestId: r.public_request_id as string, handled: true })}
            title="Take it off the list without placing a sign"
          >
            Mark handled
          </button>
        )}

        {r.household_id && (
          // /map consumes ?household= and opens straight onto the door card.
          <Link className="btn btn--small" to={`/map?household=${encodeURIComponent(r.household_id)}`}>
            Show on the map
          </Link>
        )}
      </div>
    </li>
  );
}
