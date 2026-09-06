import type { AssignmentStatus } from '../api/types';
import { n } from '../components/ui';
import { ASSIGNMENT_LABELS, pct } from './status';

/**
 * Doors knocked out of doors assigned. The bar is decorative; the count beside it is the
 * accessible version, so no aria-label duplicates text a screen reader already reads.
 */
export function Progress({ done, total }: { done: number; total: number }) {
  const p = pct(done, total);
  return (
    <div className="cv-progress">
      <div className="cv-progress__track" aria-hidden="true">
        <div className="cv-progress__fill" style={{ width: `${p}%` }} />
      </div>
      <span className="cv-progress__text num">
        {n(done)}<span className="cv-progress__of">/{n(total)}</span> doors · {p}%
      </span>
    </div>
  );
}

export function StatusChip({ status }: { status: AssignmentStatus }) {
  return <span className={`cv-status cv-status--${status}`}>{ASSIGNMENT_LABELS[status]}</span>;
}
