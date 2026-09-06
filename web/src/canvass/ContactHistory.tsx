import type { CSSProperties } from 'react';
import { useContacts } from '../api/hooks';
import type { Contact } from '../api/types';
import { RESULT_LABELS } from '../api/types';
import { ErrorBox, LoadingRows, fmtDate } from '../components/ui';
import { resultColour } from './status';

const FLAGS: [keyof Contact, string][] = [
  ['wants_sign', 'Sign'],
  ['wants_volunteer', 'Volunteer'],
  ['needs_ride', 'Ride'],
  ['follow_up', 'Follow up'],
];

/** What the last canvasser found here. Read-only: contacts are append-only, corrections are new rows. */
export function ContactHistory({ householdId }: { householdId: string }) {
  const contacts = useContacts(householdId);
  const rows = contacts.data ?? [];

  if (contacts.isPending) return <LoadingRows rows={2} />;
  if (contacts.isError) {
    return <ErrorBox title="Could not load previous visits" error={contacts.error} onRetry={() => void contacts.refetch()} compact />;
  }
  if (rows.length === 0) return <p className="muted">No previous visits.</p>;

  return (
    <ul className="cv-history">
      {rows.map((c) => (
        <li key={c.id} className="cv-history__item">
          <div className="cv-history__head">
            <span className="cv-history__result" style={{ '--dot': resultColour(c.result) } as CSSProperties}>
              {RESULT_LABELS[c.result]}
            </span>
            <span className="muted small">{fmtDate(c.at)}</span>
          </div>
          <div className="muted small">
            {[c.voter_name, c.user_name && `by ${c.user_name}`].filter(Boolean).join(' · ')}
          </div>
          <div className="cv-history__tags">
            {c.support !== null && <span className="tag tag--mini">Support {c.support}/5</span>}
            {FLAGS.filter(([k]) => c[k]).map(([k, label]) => (
              <span key={k} className="tag tag--mini tag--neutral">
                {label}
              </span>
            ))}
          </div>
          {c.note && <p className="cv-history__note">{c.note}</p>}
        </li>
      ))}
    </ul>
  );
}
