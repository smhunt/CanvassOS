import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError } from '../api/client';
import { useHousehold } from '../api/hooks';
import { RESULT_LABELS, type ContactResult, type Household, type PointProps, type User, type Voter } from '../api/types';
import { isOrganizer } from '../auth';
import { ErrorBox, LoadingRows, n, titleCase, wardLabel } from '../components/ui';
import { coordsOf, mapsUrl } from '../canvass/directions';
import { RecordVisit } from '../canvass/RecordVisit';
import { QUALITY_LABELS, wardColour } from './palette';

export interface Selection {
  id: string;
  /** Point properties when the selection came from the map (absent for legal-description rows). */
  props?: PointProps;
}

interface Props {
  selection: Selection;
  user: User;
  onClose: () => void;
  onFly: (lon: number, lat: number) => void;
}

export function HouseholdCard({ selection, user, onClose, onFly }: Props) {
  const organizer = isOrganizer(user);
  const hh = useHousehold(selection.id, organizer);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, [selection.id]);

  const p = selection.props;
  const ward = hh.data?.ward ?? p?.ward;
  const community = hh.data?.community ?? p?.community ?? null;

  return (
    <aside className="card sheet" aria-label="Household" role="dialog" aria-modal="false">
      <div className="sheet__handle" aria-hidden="true" />
      <header className="sheet__head">
        <div className="sheet__title">
          {organizer ? (
            hh.data ? (
              <h2>{hh.data.address}</h2>
            ) : hh.isPending ? (
              <h2 className="muted">Loading…</h2>
            ) : (
              <h2>Household</h2>
            )
          ) : (
            <h2>Household</h2>
          )}
          <div className="sheet__sub">
            {ward && (
              <span className="tag" style={{ '--tag': wardColour(ward) } as CSSProperties}>
                {wardLabel(ward)}
              </span>
            )}
            {community && <span>{titleCase(community)}</span>}
            {hh.data?.locality && hh.data.locality.toUpperCase() !== community && <span>{hh.data.locality}</span>}
            {hh.data?.postal && <span className="mono">{hh.data.postal}</span>}
          </div>
        </div>
        <button ref={closeRef} type="button" className="btn btn--icon" onClick={onClose} aria-label="Close household card">
          <CloseIcon />
        </button>
      </header>

      <div className="sheet__body">
        {!organizer && <VolunteerView props={p} />}
        {organizer && hh.isPending && <LoadingRows rows={4} label="Loading this household…" />}
        {organizer && hh.isError && (
          <ErrorBox
            title={isApiError(hh.error, 404) ? 'Household not found' : isApiError(hh.error, 403) ? 'Not available for your role' : 'Could not load this household'}
            error={hh.error}
            onRetry={isApiError(hh.error) ? undefined : () => void hh.refetch()}
            compact
          />
        )}
        {organizer && hh.data && <OrganizerView hh={hh.data} onFly={onFly} />}
      </div>
    </aside>
  );
}

function VolunteerView({ props }: { props: PointProps | undefined }) {
  return (
    <div className="stack">
      <p className="big-number">
        {n(props?.n ?? 0)} <span className="muted">{props?.n === 1 ? 'voter' : 'voters'} at this door</span>
      </p>
      {props?.inst && <p className="tag tag--neutral">Institution / multi-unit</p>}
      <div className="alert alert--info">
        <div>
          <strong>Volunteer view</strong> — turf details (names and the door screen) arrive in Phase 2. Until then the map shows
          household points only.
        </div>
      </div>
    </div>
  );
}

/**
 * What you can actually DO from a door you tapped on the map.
 *
 * Without this the card was a read-only dead end: it told you who lived there and then offered
 * nothing, so recording a visit meant remembering the address, finding the turf, and walking in
 * from the door screen. The actions are the same whether or not the door is in a turf — a door
 * outside every turf is the *most* likely one to need a sign or a set of directions, not the least.
 */
function DoorActions({ hh }: { hh: Household }) {
  const coords = coordsOf(hh);
  const turf = hh.turfs[0];
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<ContactResult | null>(null);
  const qc = useQueryClient();

  if (recording) {
    return (
      <RecordVisit
        householdId={hh.id}
        address={hh.address}
        voters={hh.voters}
        turfId={turf?.id ?? null}
        onRecorded={(r) => {
          setRecording(false);
          setRecorded(r);
          // The card's own status line and the map's colouring both read this door.
          void qc.invalidateQueries({ queryKey: ['household', hh.id] });
          void qc.invalidateQueries({ queryKey: ['points'] });
        }}
        onCancel={() => setRecording(false)}
      />
    );
  }

  return (
    <div className="hc-actions">
      {recorded && (
        <p className="hc-actions__note" role="status">
          Recorded: <strong>{RESULT_LABELS[recorded]}</strong>.
        </p>
      )}
      {/* The whole point of the card being actionable. Works with or without a turf — `turf_id` is
          nullable on `contact`, so a door in no turf is still a door somebody knocked. */}
      <button type="button" className="btn btn--primary btn--small" onClick={() => setRecording(true)}>
        Record a visit
      </button>
      {turf ? (
        <Link className="btn btn--small" to={`/canvass/${turf.id}`}>
          Open in the door screen
        </Link>
      ) : null}
      <Link
        className="btn btn--small"
        to={`/signs?tab=place&household=${encodeURIComponent(hh.id)}&address=${encodeURIComponent(hh.address)}`}
      >
        Place a lawn sign
      </Link>
      {coords && (
        // The phone's own map app, because the last hundred metres of a rural lane is not something
        // this app is going to do better than Apple or Google.
        <a className="btn btn--small" href={mapsUrl(coords.lat, coords.lon)} target="_blank" rel="noreferrer noopener">
          Directions
        </a>
      )}
      {hh.turfs.length > 1 && (
        <p className="muted small hc-actions__note">
          Also in {hh.turfs.slice(1).map((t) => t.name).join(', ')}.
        </p>
      )}
      {!turf && (
        <p className="muted small hc-actions__note">
          Not in any turf you can walk, so there is no door screen for it — the visit is still
          recorded against the door.
        </p>
      )}
    </div>
  );
}

function OrganizerView({ hh, onFly }: { hh: Household; onFly: (lon: number, lat: number) => void }) {
  const nonres = hh.n_nonresident ?? 0;
  const mailingVoters = hh.voters.filter((v) => v.mailing_address);
  const differing = hh.voters.filter((v) => v.mail_differs_real).length;
  return (
    <div className="stack">
      <DoorActions hh={hh} />

      <section aria-labelledby="voters-h">
        <h3 id="voters-h" className="sheet__h3">
          Voters <span className="muted">({hh.voters.length})</span>
        </h3>
        {hh.voters.length === 0 ? (
          <p className="muted">No voters listed at this address.</p>
        ) : (
          <ul className="voter-list">
            {hh.voters.map((v) => (
              <VoterRow key={v.id} v={v} />
            ))}
          </ul>
        )}
      </section>

      {/* Who is at the door is the reason this card is open, so it comes first. Everything below is
          about the RECORD — counts, how well the address matched, where the map is — which is
          reference material a canvasser scrolls to, not what they came for. */}
      <section aria-labelledby="record-h">
        <h3 id="record-h" className="sheet__h3">
          This record
        </h3>
        <div className="kv">
          <div>
            <span className="kv__k">Voters</span>
            <span className="kv__v">{n(hh.n_voters)}</span>
          </div>
          <div>
            <span className="kv__k">Non-resident</span>
            <span className={`kv__v${nonres ? ' kv__v--accent' : ''}`}>{n(nonres)}</span>
          </div>
          <div>
            <span className="kv__k">PO box</span>
            <span className="kv__v">{n(hh.n_po_box ?? 0)}</span>
          </div>
        </div>

        <div className="tags">
          <span className={`tag tag--q-${hh.record_quality}`}>{QUALITY_LABELS[hh.record_quality] ?? hh.record_quality}</span>
          {hh.is_institution && <span className="tag tag--neutral">Institution / multi-unit</span>}
          {hh.is_legal && <span className="tag tag--neutral">Unmapped parcel</span>}
          {hh.addr_match && hh.addr_match !== 'exact' && !hh.is_legal && <span className="tag tag--neutral">match: {hh.addr_match}</span>}
        </div>
        {hh.property_address_raw && hh.property_address_raw !== hh.address && (
          <p className="muted small">
            Listed as: <span className="mono">{hh.property_address_raw}</span>
          </p>
        )}
        {hh.lat !== null && hh.lon !== null && (
          <button type="button" className="btn btn--small" onClick={() => onFly(hh.lon as number, hh.lat as number)}>
            Centre on map
          </button>
        )}
      </section>

      {mailingVoters.length > 0 && (
        <details className="disclosure">
          <summary>
            Mailing addresses{' '}
            <span className="muted">
              ({differing ? `${differing} differ from the door` : 'same as the door'})
            </span>
          </summary>
          <ul className="mail-list">
            {mailingVoters.map((v) => (
              <li key={v.id}>
                <span className="mail-list__name">{v.display_name}</span>
                <span className={`mail-list__addr${v.mail_differs_real ? ' mail-list__addr--differs' : ''}`}>
                  {v.mailing_address}
                  {v.mail_kind && v.mail_kind !== 'street' && <span className="tag tag--neutral tag--mini">{v.mail_kind.replace('_', ' ')}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <section aria-labelledby="status-h">
        <h3 id="status-h" className="sheet__h3">
          Canvass status
        </h3>
        {hh.status.last_result ? (
          <p>
            {hh.status.last_result} · {hh.status.last_contact_at} · {hh.status.last_user_name}
          </p>
        ) : (
          <p className="muted">
            Not yet contacted. <span className="tag tag--neutral tag--mini">Phase 2</span>
          </p>
        )}
      </section>
      <p className="muted small">
        ID <span className="mono">{hh.id}</span> · this view was recorded in the audit log.
      </p>
    </div>
  );
}

function VoterRow({ v }: { v: Voter }) {
  const rc = v.resident_class ?? '';
  return (
    <li className="voter">
      <div className="voter__name">
        <span>{v.display_name}</span>
        {v.full_name !== v.display_name && <span className="muted small voter__full">{v.full_name}</span>}
      </div>
      <div className="voter__badges">
        {rc && <span className={`tag tag--mini tag--rc-${rc.replace(/[^a-z]/g, '')}`}>{rc}</span>}
        {v.mail_kind === 'po_box' && <span className="tag tag--mini tag--neutral">PO box</span>}
      </div>
    </li>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}
