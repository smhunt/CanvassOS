import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useRecordContact } from '../api/hooks';
import type { ContactInput, ContactResult, Door } from '../api/types';
import { CONTACT_RESULTS, RESULT_LABELS } from '../api/types';
import { ErrorBox, Spinner, n, titleCase } from '../components/ui';
import { ContactHistory } from './ContactHistory';
import { SpokeForm, type SpokeDetail } from './SpokeForm';
import { resultColour } from './status';

interface Props {
  door: Door;
  turfId: string;
  /** 1-based position in walking order, for "Door 4 of 26". */
  index: number;
  total: number;
  onClose: () => void;
  onRecorded: (result: ContactResult) => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}

export function DoorSheet({ door, turfId, index, total, onClose, onRecorded, onPrev, onNext }: Props) {
  const [spoke, setSpoke] = useState(false);
  const record = useRecordContact();
  // The submitted body is kept so a retry re-sends the same client_id; the API treats that as the
  // same door, so a retry after a dropped connection cannot double-count it.
  const attempt = useRef<ContactInput | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headRef.current?.focus({ preventScroll: true });
  }, [door.household_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function send(input: Omit<ContactInput, 'client_id'>) {
    const body: ContactInput = { ...input, client_id: crypto.randomUUID() };
    attempt.current = body;
    record.mutate(body, { onSuccess: () => onRecorded(body.result) });
  }

  function retry() {
    const body = attempt.current;
    if (!body) return;
    record.mutate(body, { onSuccess: () => onRecorded(body.result) });
  }

  function submitSpoke(d: SpokeDetail) {
    const note = d.note.trim();
    // The API takes voter_id / support / note as optional, not nullable, so anything the volunteer
    // left blank is omitted rather than sent as null.
    send({
      household_id: door.household_id,
      turf_id: turfId,
      result: 'spoke',
      ...(d.voter_id ? { voter_id: d.voter_id } : {}),
      ...(d.support !== null ? { support: d.support } : {}),
      ...(note ? { note } : {}),
      wants_sign: d.wants_sign,
      wants_volunteer: d.wants_volunteer,
      needs_ride: d.needs_ride,
      follow_up: d.follow_up,
    });
  }

  const pending = record.isPending;
  const headId = 'cv-door-h';

  return (
    <div className="cv-sheet-wrap" role="presentation">
      <div className="cv-sheet__scrim" onClick={onClose} aria-hidden="true" />
      <div className="card cv-sheet" role="dialog" aria-modal="true" aria-labelledby={headId}>
        <div className="cv-sheet__handle" aria-hidden="true" />
        <header className="cv-sheet__head">
          <div className="cv-sheet__title">
            <h2 id={headId} ref={headRef} tabIndex={-1}>
              {door.address}
            </h2>
            <div className="cv-sheet__sub">
              <span>
                Door {index} of {total}
              </span>
              {door.community && <span>{titleCase(door.community)}</span>}
              <span>{door.n_voters === 1 ? '1 voter' : `${n(door.n_voters)} voters`}</span>
            </div>
          </div>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close door">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </header>

        <nav className="cv-sheet__nav" aria-label="Walking order">
          <button type="button" className="btn btn--small cv-nav" onClick={onPrev ?? undefined} disabled={!onPrev}>
            ‹ Previous door
          </button>
          <button type="button" className="btn btn--small cv-nav" onClick={onNext ?? undefined} disabled={!onNext}>
            Next door ›
          </button>
        </nav>

        <div className="cv-sheet__body">
          <section aria-labelledby="cv-voters-h">
            <h3 id="cv-voters-h" className="sheet__h3">
              On the list here
            </h3>
            {door.voters.length === 0 ? (
              <p className="muted">No names listed at this address.</p>
            ) : (
              <ul className="cv-voters">
                {door.voters.map((v) => (
                  <li key={v.id} className="cv-voter">
                    <span className="cv-voter__name">{v.display_name}</span>
                    {v.last_support !== null && <span className="tag tag--mini">Support {v.last_support}/5</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="cv-history-h">
            <h3 id="cv-history-h" className="sheet__h3">
              Previous visits
            </h3>
            <ContactHistory householdId={door.household_id} />
          </section>
        </div>

        <div className="cv-sheet__foot">
          {record.isError && (
            <ErrorBox
              title="Not saved — no connection?"
              error={record.error}
              onRetry={pending ? undefined : retry}
              compact
            />
          )}
          {spoke ? (
            <SpokeForm voters={door.voters} pending={pending} onSubmit={submitSpoke} onCancel={() => setSpoke(false)} />
          ) : (
            <>
              <p className="cv-results__hint muted small">What happened at this door?</p>
              <div className="cv-results">
                {CONTACT_RESULTS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={`cv-result cv-result--${r}`}
                    style={{ '--dot': resultColour(r) } as CSSProperties}
                    disabled={pending}
                    onClick={() => (r === 'spoke' ? setSpoke(true) : send({ household_id: door.household_id, turf_id: turfId, result: r }))}
                  >
                    {pending && attempt.current?.result === r ? <Spinner size={18} /> : <span className="cv-result__dot" aria-hidden="true" />}
                    {RESULT_LABELS[r]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
