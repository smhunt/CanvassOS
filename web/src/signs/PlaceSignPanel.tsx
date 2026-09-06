/**
 * "Place a sign" — the field flow, and the only screen here designed to be used one-handed while
 * standing on a shoulder in the wind.
 *
 * Shape borrowed from the door screen (`src/canvass/DoorSheet.tsx`): the submitted body is held in
 * a ref so a retry after a dropped connection re-sends the SAME `client_id`, which the API treats
 * as the same sign. Retrying on one bar of rural signal can therefore never plant a duplicate.
 */
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { usePlaceSign } from '../api/hooks';
import type { Sign, SignInput } from '../api/types';
import { ErrorBox, Spinner } from '../components/ui';
import {
  ACCURACY_WARN_M,
  formatAccuracy,
  formatCoord,
  isInMiddlesexCentre,
  useGeoFix,
  type GeoFix,
} from './geolocation';
import { PhotoCapture } from './PhotoCapture';

interface Props {
  /** Prefilled from `?household=` when the volunteer came from the delivery run list. */
  household: { id: string; address: string | null } | null;
  onClearHousehold: () => void;
}

const EMPTY = { label: '', size: '', permission_by: '', note: '' };

export function PlaceSignPanel({ household, onClearHousehold }: Props) {
  const geo = useGeoFix();
  const place = usePlaceSign();
  const [form, setForm] = useState(EMPTY);
  const [created, setCreated] = useState<Sign | null>(null);
  // The exact body that was sent, kept for retries — same client_id, same sign.
  const attempt = useRef<SignInput | null>(null);

  const field = (k: keyof typeof EMPTY) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const fix = geo.fix;
    if (!fix) return;
    const body: SignInput = {
      lat: fix.lat,
      lon: fix.lon,
      accuracy_m: fix.accuracy_m,
      status: 'placed',
      // Blank boxes are omitted rather than sent as empty strings; the API takes null or absent.
      ...(household ? { household_id: household.id } : {}),
      ...(form.label.trim() ? { label: form.label.trim() } : {}),
      ...(form.size.trim() ? { size: form.size.trim() } : {}),
      ...(form.permission_by.trim() ? { permission_by: form.permission_by.trim() } : {}),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
      client_id: crypto.randomUUID(),
    };
    attempt.current = body;
    place.mutate(body, { onSuccess: (r) => setCreated(r.sign) });
  }

  function retry() {
    const body = attempt.current;
    if (body) place.mutate(body, { onSuccess: (r) => setCreated(r.sign) });
  }

  function again() {
    setCreated(null);
    setForm(EMPTY);
    attempt.current = null;
    place.reset();
    geo.clear();
    onClearHousehold();
  }

  if (created) {
    return <PlacedCard sign={created} onAgain={again} />;
  }

  const fix = geo.fix;
  const outsideArea = fix ? !isInMiddlesexCentre(fix) : false;
  const canSave = !!fix && !outsideArea && !place.isPending;

  return (
    <form className="card sg-place" onSubmit={submit}>
      <FixBlock geo={geo} />

      {outsideArea && fix && (
        <div className="alert alert--danger alert--compact" role="alert">
          <div>
            <strong>That fix is outside Middlesex Centre</strong>
            {/* The API refuses this outright (`coordinate_out_of_range`). Saying so here spares a
                doomed request from somebody on one bar of signal. */}
            <div className="alert__detail">
              {formatCoord(fix.lat)}, {formatCoord(fix.lon)} is not in the municipality, so it will be refused. Wait a
              few seconds outdoors and take the fix again.
            </div>
          </div>
        </div>
      )}

      <fieldset className="fs sg-fs">
        <legend>Where the sign is</legend>

        {household ? (
          <div className="sg-door">
            <div>
              <span className="field__label">At this door</span>
              <p className="sg-door__addr">{household.address ?? household.id}</p>
            </div>
            <button type="button" className="btn btn--small" onClick={onClearHousehold}>
              Not at this door
            </button>
          </div>
        ) : (
          <p className="field__hint sg-door__none">
            Not linked to a door on the voters list — road allowances and corner lots are normal. To link one, start
            from the <strong>Sign requests</strong> tab.
          </p>
        )}

        <div className="field">
          <label className="field__label" htmlFor="sg-label">
            Label
          </label>
          <input
            id="sg-label"
            type="text"
            maxLength={200}
            value={form.label}
            onChange={(e) => field('label')(e.target.value)}
            placeholder="Corner of Ilderton Rd at the church"
            aria-describedby="sg-label-hint"
            autoComplete="off"
          />
          <p className="field__hint" id="sg-label-hint">
            How the pickup crew will recognise the spot. Worth writing even with a good fix.
          </p>
        </div>

        <div className="field field--short">
          <label className="field__label" htmlFor="sg-size">
            Size
          </label>
          <input
            id="sg-size"
            type="text"
            maxLength={40}
            value={form.size}
            onChange={(e) => field('size')(e.target.value)}
            placeholder="small / 4×8"
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sg-permission">
            Permission from
          </label>
          <input
            id="sg-permission"
            type="text"
            maxLength={200}
            value={form.permission_by}
            onChange={(e) => field('permission_by')(e.target.value)}
            placeholder="Who at the property agreed"
            aria-describedby="sg-permission-hint"
            autoComplete="off"
          />
          <p className="field__hint" id="sg-permission-hint">
            The name of whoever said yes, so a complaint later can be answered.
          </p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="sg-note">
            Note
          </label>
          <textarea
            id="sg-note"
            className="sg-textarea"
            maxLength={2000}
            rows={3}
            value={form.note}
            onChange={(e) => field('note')(e.target.value)}
            placeholder="Behind the cedar hedge, facing east"
          />
        </div>
      </fieldset>

      {place.isError && (
        <ErrorBox title="Not saved — no connection?" error={place.error} onRetry={place.isPending ? undefined : retry} compact />
      )}

      <button type="submit" className="btn btn--primary btn--block sg-save" disabled={!canSave}>
        {place.isPending ? (
          <>
            <Spinner size={18} /> Saving…
          </>
        ) : (
          'Save this sign'
        )}
      </button>
      {!fix && (
        <p className="muted small sg-save__hint">A sign cannot be saved without a GPS fix.</p>
      )}
    </form>
  );
}

/** The GPS block: take it, look at the accuracy, take it again if it is poor. */
function FixBlock({ geo }: { geo: ReturnType<typeof useGeoFix> }) {
  const { fix, failure, pending, attempts } = geo;
  const poor = fix !== null && (fix.accuracy_m === null || fix.accuracy_m > ACCURACY_WARN_M);

  return (
    <section className="sg-fix" aria-labelledby="sg-fix-h">
      <h2 id="sg-fix-h" className="sheet__h3">
        GPS fix
      </h2>

      {/* Announced, because the accuracy number is the reason this screen exists and it changes
          under the volunteer's thumb as they re-take the fix. */}
      <div className="sg-fix__readout" aria-live="polite">
        {pending && (
          <p className="sg-fix__pending">
            <Spinner size={18} /> Getting a fix — stand still outdoors…
          </p>
        )}
        {!pending && !fix && !failure && (
          <p className="muted">No fix yet. Stand at the sign and tap the button below.</p>
        )}
        {!pending && fix && <FixReadout fix={fix} poor={poor} attempts={attempts} />}
      </div>

      {failure && (
        <div className="alert alert--danger alert--compact" role="alert">
          <div>
            <strong>No location from this device</strong>
            <div className="alert__detail">{failure.message}</div>
          </div>
        </div>
      )}

      <button type="button" className={`btn btn--block sg-fix__btn${fix ? '' : ' btn--primary'}`} onClick={geo.take} disabled={pending}>
        {pending ? 'Getting fix…' : fix ? 'Re-take the fix' : 'Get GPS fix'}
      </button>
      {fix && poor && (
        <p className="sg-fix__advice">
          Wait five or ten seconds and re-take it — accuracy usually improves sharply once the phone has settled, and a
          {' '}
          {formatAccuracy(fix.accuracy_m)} circle is a lot of ditch to search in November.
        </p>
      )}
    </section>
  );
}

function FixReadout({ fix, poor, attempts }: { fix: GeoFix; poor: boolean; attempts: number }) {
  return (
    <div className="sg-fix__grid">
      <div className={`sg-acc${poor ? ' sg-acc--poor' : ' sg-acc--good'}`}>
        <span className="sg-acc__value num">{formatAccuracy(fix.accuracy_m)}</span>
        <span className="sg-acc__label">{poor ? 'accuracy — too vague' : 'accuracy — good'}</span>
      </div>
      <dl className="sg-fix__coords">
        <div>
          <dt>Latitude</dt>
          <dd className="mono">{formatCoord(fix.lat)}</dd>
        </div>
        <div>
          <dt>Longitude</dt>
          <dd className="mono">{formatCoord(fix.lon)}</dd>
        </div>
        <div>
          <dt>Taken</dt>
          <dd>
            {new Date(fix.at).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            {attempts > 1 && <span className="muted"> · fix {attempts}</span>}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** After the sign is saved: the record, then the optional photo. */
function PlacedCard({ sign, onAgain }: { sign: Sign; onAgain: () => void }) {
  const describe = sign.label ?? sign.address ?? `${formatCoord(sign.lat)}, ${formatCoord(sign.lon)}`;
  return (
    <div className="card sg-placed">
      <div className="alert alert--ok alert--compact" role="status">
        <div>
          <strong>Sign recorded</strong>
          <div className="alert__detail">
            {describe} · fix good to {formatAccuracy(sign.accuracy_m)}
          </div>
        </div>
      </div>

      <PhotoCapture signId={sign.id} describe={describe} />

      <div className="sg-placed__actions">
        <button type="button" className="btn btn--primary" onClick={onAgain}>
          Place another sign
        </button>
        <Link className="btn" to="/signs?tab=pickup">
          See the pickup list
        </Link>
      </div>
    </div>
  );
}
