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
import {
  useCancelSignRequest,
  useCancelledSignRequests,
  useDeleteManualRequest,
  useHandleRequest,
  useMe,
  usePublicRequests,
  useRestoreSignRequest,
  useSignRequests,
} from '../api/hooks';
import { CANCEL_REASONS, CANCEL_REASON_LABELS, type CancelReason } from '../api/types';
import { HouseholdActions } from '../canvass/HouseholdActions';
import { EmptyState, ErrorBox, LoadingCards, fmtDate, n, titleCase, wardLabel } from '../components/ui';
import { wardColour } from '../map/palette';
import { relativeDay } from '../reports/relative';
import { ManualRequestForm } from './ManualRequestForm';
import { RoutePanel } from './RoutePanel';
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
  const [routing, setRouting] = useState(false);
  // The bin. Only an organizer can open it, and only they can put something back.
  const [showBin, setShowBin] = useState(false);
  const binned = useCancelledSignRequests(organizer && showBin);
  // A public request taken off the list is `handled`, which is its own reversible stamp — so the
  // bin shows those too rather than pretending there are two different kinds of "cancelled".
  const handledPublics = usePublicRequests(false, organizer && showBin);

  const rows = useMemo(
    () => sortRequests([...fromSignRequests(toDeliveryRequests(doors.data)), ...fromPublicRequests(publics.data)]),
    [doors.data, publics.data],
  );

  const binRows = useMemo(
    () =>
      sortRequests([
        ...fromSignRequests(toDeliveryRequests(binned.data)),
        // `open=false` returns everything, so keep only the ones actually dealt with.
        ...fromPublicRequests((handledPublics.data ?? []).filter((r) => r.handled_at !== null)),
      ]),
    [binned.data, handledPublics.data],
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
        {shown.length > 0 && !routing && (
          <button type="button" className="btn btn--small" onClick={() => setRouting(true)}>
            Plan a route
          </button>
        )}
        <p className="muted small sg-toolbar__count" aria-live="polite">
          {n(shown.length)} {shown.length === 1 ? 'door waiting' : 'doors waiting'}
          {ward && ` in ${wardLabel(ward)} — phoned-in requests have no ward and are hidden`}
        </p>
      </div>

      {/* Routes exactly what the list shows, so the ward filter above is also "one ward's run". */}
      {routing && shown.length > 0 && <RoutePanel rows={shown} onClose={() => setRouting(false)} />}

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

      {organizer && (
        <div className="sg-toolbar">
          <button type="button" className="btn btn--small" aria-expanded={showBin} onClick={() => setShowBin((v) => !v)}>
            {showBin ? 'Hide cancelled requests' : 'Show cancelled requests'}
          </button>
        </div>
      )}

      {organizer && showBin && (
        <section aria-labelledby="sg-bin-h">
          <h3 id="sg-bin-h" className="sheet__h3">
            Cancelled
          </h3>
          <p className="muted small">
            Nothing here was deleted — a cancelled request is stamped with who cancelled it and why, and putting one
            back restores it exactly. The permanent record of both is in the audit log.
          </p>
          {(binned.isPending || handledPublics.isPending) && <LoadingCards count={2} label="Loading cancelled requests…" />}
          {binned.isError && <ErrorBox title="Could not load cancelled requests" error={binned.error} compact />}
          {!binned.isPending && binRows.length === 0 && (
            <div className="card">
              <EmptyState title="Nothing has been cancelled." />
            </div>
          )}
          {binRows.length > 0 && (
            <ul className="sg-list">
              {binRows.map((r) => (
                <BinnedRow key={r.key} r={r} />
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}

/** One cancelled request, and the one button that puts it back. */
function BinnedRow({ r }: { r: UnifiedRequest }) {
  const restore = useRestoreSignRequest();
  const handle = useHandleRequest();
  const busy = restore.isPending || handle.isPending;

  return (
    <li className="card sg-row">
      <div className="sg-row__head">
        <h3 className="sg-row__title">{r.title}</h3>
        <div className="sg-row__tags">
          <span className="chip">{ORIGIN_LABELS[r.origin]}</span>
          {r.cancel_reason && <span className="chip">{CANCEL_REASON_LABELS[r.cancel_reason]}</span>}
        </div>
      </div>
      <p className="muted small sg-row__meta">
        {r.cancelled_at ? (
          <>
            Cancelled {relativeDay(r.cancelled_at)} · {fmtDate(r.cancelled_at)}
            {r.cancelled_by_name && ` · by ${r.cancelled_by_name}`}
          </>
        ) : (
          <>Marked handled — no sign was placed against it.</>
        )}
      </p>
      {r.cancel_note && <p className="sg-note">{r.cancel_note}</p>}
      {restore.isError && <ErrorBox title="Not restored" error={restore.error} compact />}
      <div className="sg-row__actions">
        <button
          type="button"
          className="btn btn--small"
          disabled={busy}
          onClick={() =>
            r.public_request_id
              ? handle.mutate({ requestId: r.public_request_id, handled: false })
              : r.household_id && restore.mutate({ householdId: r.household_id })
          }
        >
          Put it back on the list
        </button>
      </div>
    </li>
  );
}

/**
 * Cancelling, in two taps: the reason first, then the confirmation.
 *
 * The reason is not decoration. "Was that spam or was somebody testing" is exactly the question
 * asked of the audit log months later, and a free-text box would make the answer unreadable in
 * aggregate — so it is a fixed list, and the optional note carries anything else.
 */
function CancelRequest({ householdId, onDone }: { householdId: string; onDone: () => void }) {
  const cancel = useCancelSignRequest();
  const [reason, setReason] = useState<CancelReason>('test');
  const [note, setNote] = useState('');

  return (
    // `.field` is the form-control wrapper the rest of the app uses (see LegalList's ward picker).
    // A bare <select>/<input> here would sit at the browser's default height beside 44px buttons on
    // a phone — the tap-target rule on this row is `.sg-row__actions .btn`, which they are not.
    <div className="sg-row__actions">
      <label className="field field--inline">
        <span className="field__label">Why</span>
        <select value={reason} onChange={(e) => setReason(e.target.value as CancelReason)}>
          {CANCEL_REASONS.map((v) => (
            <option key={v} value={v}>
              {CANCEL_REASON_LABELS[v]}
            </option>
          ))}
        </select>
      </label>
      <label className="field field--inline">
        <span className="field__label">Note</span>
        <input type="text" placeholder="optional" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button
        type="button"
        className="btn btn--small btn--danger-outline"
        disabled={cancel.isPending}
        onClick={() =>
          cancel.mutate({ householdId, reason, ...(note.trim() ? { note: note.trim() } : {}) }, { onSuccess: onDone })
        }
      >
        Cancel this request
      </button>
      <button type="button" className="btn btn--small" onClick={onDone} disabled={cancel.isPending}>
        Keep it
      </button>
      {cancel.isError && <ErrorBox title="Not cancelled" error={cancel.error} compact />}
    </div>
  );
}

function RequestRow({ r, onEdit, busy }: { r: UnifiedRequest; onEdit: () => void; busy: boolean }) {
  const me = useMe();
  const organizer = me.data?.role === 'organizer' || me.data?.role === 'admin';
  const remove = useDeleteManualRequest();
  const handle = useHandleRequest();
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);

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

      {/* A door-derived request is cancelled by stamping its sign row; a phoned-in one is "marked
          handled", which is the same idea and already reversible. Both are below. */}
      {cancelling && r.household_id && (
        <CancelRequest householdId={r.household_id} onDone={() => setCancelling(false)} />
      )}

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

        {/* Organizer-only, the same rule as deleting a sign: a request recorded by mistake should be
            removable, but what a door asked for is not a volunteer's to erase. Shown disabled with
            the reason rather than hidden, so the row reads the same for everyone. Only for
            door-anchored rows — a public request's equivalent is "Mark handled", beside it. */}
        {!r.public_request_id && !cancelling && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setCancelling(true)}
            disabled={!organizer || !r.household_id}
            title={
              !organizer
                ? 'Only an organizer can cancel a request.'
                : !r.household_id
                  ? 'This request is not linked to a door.'
                  : 'Take it off the list — testing, spam, or they changed their mind'
            }
          >
            Cancel request
          </button>
        )}
      </div>
    </li>
  );
}
