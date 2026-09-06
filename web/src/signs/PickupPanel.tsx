/**
 * The pickup list — every sign still standing, which is what the retrieval crew works from after
 * election day. Signs must be down within the window set by the municipal sign by-law, so this list
 * is the thing that stops a forgotten sign on a concession road becoming a fine.
 *
 * Order comes from the API (ward → label/address → latitude): "work one ward, then drive up the
 * concession". It is deliberately not re-sorted here beyond the ward filter, so the list a
 * volunteer is holding stays the list the next volunteer sees.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { useUpdateSign, usePickupList } from '../api/hooks';
import { SIGN_STATUS_LABELS } from '../api/types';
import { EmptyState, ErrorBox, LoadingRows, Spinner, fmtDate, n, wardLabel } from '../components/ui';
import { wardColour } from '../map/palette';
import { ACCURACY_WARN_M, formatAccuracy, formatCoord } from './geolocation';
import { PhotoStrip } from './PhotoStrip';
import { mapsUrl, toPickupSigns, type PickupSign } from './rows';

export function PickupPanel() {
  const pickup = usePickupList();
  const [ward, setWard] = useState('');

  const rows = useMemo(() => toPickupSigns(pickup.data), [pickup.data]);
  const wards = useMemo(() => [...new Set(rows.map((s) => s.ward).filter((w): w is string => !!w))].sort(), [rows]);
  const shown = useMemo(() => (ward ? rows.filter((s) => s.ward === ward) : rows), [rows, ward]);

  if (pickup.isPending) {
    return (
      <div className="card">
        <LoadingRows rows={4} />
      </div>
    );
  }
  if (pickup.isError) {
    return <ErrorBox title="Could not load the pickup list" error={pickup.error} onRetry={() => void pickup.refetch()} />;
  }

  return (
    <>
      <div className="sg-toolbar">
        <p className="sg-standing" aria-live="polite">
          <span className="sg-standing__n num">{n(shown.length)}</span>
          <span className="sg-standing__label">
            still standing{ward ? ` in ${wardLabel(ward)}` : ''}
            {ward && rows.length !== shown.length && <span className="muted"> of {n(rows.length)}</span>}
          </span>
        </p>
        {wards.length > 1 && (
          <label className="select-pill">
            <span className="visually-hidden">Filter by ward</span>
            <select value={ward} onChange={(e) => setWard(e.target.value)} aria-label="Filter the pickup list by ward">
              <option value="">All wards</option>
              {wards.map((w) => (
                <option key={w} value={w}>
                  {wardLabel(w)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <EmptyState title={ward ? `Nothing left standing in ${wardLabel(ward)}.` : 'Nothing left standing.'}>
            <p>
              {ward
                ? 'Clear the ward filter to see the rest of the list.'
                : 'Every sign has been marked picked up. Signs come back onto this list if one is set back to standing.'}
            </p>
          </EmptyState>
        </div>
      ) : (
        <ul className="sg-list">
          {shown.map((s) => (
            <PickupRow key={s.id} s={s} />
          ))}
        </ul>
      )}
    </>
  );
}

function PickupRow({ s }: { s: PickupSign }) {
  const update = useUpdateSign();
  const title = s.label ?? s.address ?? 'Unlabelled sign';
  const hasFix = s.lat !== null && s.lon !== null;
  const poorFix = s.accuracy_m === null || s.accuracy_m > ACCURACY_WARN_M;

  return (
    <li className="card sg-row" style={{ '--ward': wardColour(s.ward ?? '') } as CSSProperties}>
      <div className="sg-row__head">
        <h3 className="sg-row__title">{title}</h3>
        <div className="sg-row__tags">
          {s.ward ? (
            <span className="tag" style={{ '--tag': wardColour(s.ward) } as CSSProperties}>
              {wardLabel(s.ward)}
            </span>
          ) : (
            <span className="tag tag--neutral">No ward — road allowance</span>
          )}
          {s.status === 'damaged' && <span className="tag tag--warn">{SIGN_STATUS_LABELS.damaged}</span>}
          {s.size && <span className="chip">{s.size}</span>}
        </div>
      </div>

      {s.label && s.address && <p className="muted small sg-row__addr">{s.address}</p>}

      <div className="sg-fixline">
        {hasFix ? (
          <>
            <span className="mono sg-fixline__coord">
              {formatCoord(s.lat as number)}, {formatCoord(s.lon as number)}
            </span>
            <span className={`sg-fixline__acc${poorFix ? ' sg-fixline__acc--poor' : ''}`}>
              ±{formatAccuracy(s.accuracy_m)}
              {poorFix && <span className="visually-hidden"> — a wide search area</span>}
            </span>
          </>
        ) : (
          <span className="sg-fixline__acc sg-fixline__acc--poor">No coordinate recorded</span>
        )}
      </div>

      {s.note && <p className="sg-note">{s.note}</p>}

      <p className="muted small sg-row__meta">
        Placed {fmtDate(s.placed_at)}
        {s.placed_by_name && ` · by ${s.placed_by_name}`}
      </p>

      <PhotoStrip ids={s.photo_ids} describe={title} />

      {update.isError && (
        <ErrorBox
          title="Not saved — no connection?"
          error={update.error}
          onRetry={update.isPending ? undefined : () => update.mutate({ id: s.id, status: 'removed' })}
          compact
        />
      )}

      <div className="sg-row__actions">
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={update.isPending}
          onClick={() => update.mutate({ id: s.id, status: 'removed' })}
        >
          {update.isPending ? (
            <>
              <Spinner size={16} /> Saving…
            </>
          ) : (
            'Picked up'
          )}
        </button>
        {hasFix && (
          // Opens the phone's map app. See rows.ts for why this is a Google Maps universal link
          // rather than `geo:` or an Apple Maps URL.
          <a
            className="btn btn--small"
            href={mapsUrl(s.lat as number, s.lon as number)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Directions
          </a>
        )}
      </div>
    </li>
  );
}
