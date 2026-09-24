/**
 * Sign requests that did not come from a canvasser's tablet.
 *
 * Two kinds share this list because a volunteer holding a bundle of signs does not care which:
 * rows typed in here by an organiser (`source: 'manual'` — a phone call, a text, somebody at the
 * fair) and sign-ups off the campaign website that ticked "lawn sign". They live in the same
 * `public_request` table, which is why one query serves both.
 *
 * What differs is what may be done to them. A manual row is the campaign's own note-to-self and is
 * fully editable and deletable. A website sign-up is the record of a consent somebody actually
 * gave — it is not ours to rewrite, and the five-minute website sync would re-insert a deleted one
 * by morning — so it is shown read-only with a link to the sign-ups screen, where the matcher's
 * questions get answered.
 *
 * Organizer/admin only: these rows carry a name, a phone number and an address. `GET
 * /public/requests` enforces that server-side; the panel simply is not rendered for a volunteer.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDeleteManualRequest, useHandleRequest, usePublicRequests } from '../api/hooks';
import type { PublicRequest } from '../api/types';
import { EmptyState, ErrorBox, LoadingCards, fmtDate, n } from '../components/ui';
import { relativeDay } from '../reports/relative';
import { ManualRequestForm } from './ManualRequestForm';

const isManual = (r: PublicRequest) => r.source === 'manual';

export function AskedRequestsPanel() {
  const requests = usePublicRequests(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Only the ones that asked for a sign. Somebody who signed up to volunteer is a different job and
  // belongs on the sign-ups screen, not in the hands of the crew loading signs into a truck.
  const rows = useMemo(
    () => (requests.data ?? []).filter((r) => r.wants.includes('sign')),
    [requests.data],
  );
  const editing = rows.find((r) => r.id === editingId) ?? null;

  return (
    <section className="sg-asked" aria-labelledby="sg-asked-h">
      <div className="sg-asked__head">
        <h2 id="sg-asked-h" className="sheet__h3">
          Asked by phone, text or in person
        </h2>
        {!adding && !editing && (
          <button type="button" className="btn btn--small btn--primary" onClick={() => setAdding(true)}>
            Add a request
          </button>
        )}
      </div>

      {adding && (
        <ManualRequestForm onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
      )}
      {editing && (
        <ManualRequestForm
          editing={editing}
          onDone={() => setEditingId(null)}
          onCancel={() => setEditingId(null)}
        />
      )}

      {requests.isPending && <LoadingCards count={2} label="Loading the requests…" />}
      {requests.isError && (
        <ErrorBox
          title="Could not load the requests"
          error={requests.error}
          onRetry={() => void requests.refetch()}
        />
      )}

      {!requests.isPending && !requests.isError && (
        <>
          <p className="muted small sg-toolbar__count" aria-live="polite">
            {n(rows.length)} {rows.length === 1 ? 'request waiting' : 'requests waiting'}
          </p>
          {rows.length === 0 ? (
            <div className="card">
              <EmptyState title="Nothing waiting here.">
                <p>
                  Requests you take by phone or text appear here, and so do website sign-ups that asked for a lawn
                  sign. A request drops off once a sign is placed against it.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="sg-list">
              {rows.map((r) => (
                <AskedRow key={r.id} r={r} onEdit={() => setEditingId(r.id)} busy={editingId !== null || adding} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function AskedRow({ r, onEdit, busy }: { r: PublicRequest; onEdit: () => void; busy: boolean }) {
  const remove = useDeleteManualRequest();
  const handle = useHandleRequest();
  const [confirming, setConfirming] = useState(false);
  const manual = isManual(r);

  // Everything the delivery run needs is on the line; the placing form takes it from the query
  // string and PATCHes this request handled once the sign is actually in the ground.
  const placeHref =
    `/signs?tab=place&request=${encodeURIComponent(r.id)}` +
    (r.household_id ? `&household=${encodeURIComponent(r.household_id)}` : '') +
    (r.address ? `&address=${encodeURIComponent(r.address)}` : '');

  return (
    <li className="card sg-row sg-row--asked">
      <div className="sg-row__head">
        <h3 className="sg-row__title">{r.address ?? r.name}</h3>
        <div className="sg-row__tags">
          <span className="chip">{manual ? 'taken by hand' : 'from the website'}</span>
          {r.household_id && <span className="chip">linked to a door</span>}
        </div>
      </div>

      <p className="muted small sg-row__meta">
        {r.name}
        {r.phone && ` · ${r.phone}`}
        {r.email && ` · ${r.email}`}
      </p>
      <p className="muted small sg-row__meta">
        Asked {relativeDay(r.created_at)} · {fmtDate(r.created_at)}
      </p>

      {r.note ? <p className="sg-note">{r.note}</p> : <p className="sg-note sg-note--none">No note.</p>}

      {remove.isError && <ErrorBox title="Not deleted" error={remove.error} compact />}

      <div className="sg-row__actions">
        <Link className="btn btn--small btn--primary" to={placeHref}>
          Place a sign here
        </Link>
        {manual ? (
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
                  onClick={() => remove.mutate(r.id)}
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
        ) : (
          // A website sign-up is not editable here on purpose — see the note at the top of the file.
          <Link className="btn btn--small" to="/requests">
            Open in Sign-ups
          </Link>
        )}
        <button
          type="button"
          className="btn btn--small"
          disabled={handle.isPending}
          onClick={() => handle.mutate({ requestId: r.id, handled: true })}
          title="Take it off the list without placing a sign"
        >
          Mark handled
        </button>
      </div>
    </li>
  );
}
