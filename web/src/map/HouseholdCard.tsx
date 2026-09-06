import { useEffect, useRef, type CSSProperties } from 'react';
import { isApiError } from '../api/client';
import { useHousehold } from '../api/hooks';
import type { Household, PointProps, User, Voter } from '../api/types';
import { isOrganizer } from '../auth';
import { ErrorBox, LoadingRows, n, titleCase, wardLabel } from '../components/ui';
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
        {organizer && hh.isPending && <LoadingRows rows={4} />}
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

function OrganizerView({ hh, onFly }: { hh: Household; onFly: (lon: number, lat: number) => void }) {
  const nonres = hh.n_nonresident ?? 0;
  const mailingVoters = hh.voters.filter((v) => v.mailing_address);
  const differing = hh.voters.filter((v) => v.mail_differs_real).length;
  return (
    <div className="stack">
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
