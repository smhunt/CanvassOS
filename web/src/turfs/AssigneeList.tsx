import type { TurfSummary } from '../api/types';
import { fmtDate } from '../components/ui';
import { STATUS_LABELS, STATUS_TONE } from './status';

export type Assignee = TurfSummary['assignees'][number];

interface Props {
  assignees: Assignee[];
  /** Only ever read out to screen readers, to tell two identical “Remove” buttons apart. */
  turfName: string;
  busy?: boolean;
  onMove: (a: Assignee) => void;
  onRemove: (a: Assignee) => void;
}

/**
 * The people on one turf, with what each of them is doing and the two ways to take a turf back.
 * Shared by the card and the assign dialog so a turf reads the same in both places — a long road
 * legitimately split between two walkers lists both, each removable on its own.
 * Empty is left to the caller: the card shows a chip, the dialog a sentence.
 */
export function AssigneeList({ assignees, turfName, busy, onMove, onRemove }: Props) {
  return (
    <ul className="assignees">
      {assignees.map((a) => (
        <li key={a.user_id} className="assignee">
          <div className="assignee__who">
            <span className="assignee__name">{a.name}</span>
            <span className={`tag tag--mini tag--${STATUS_TONE[a.status]}`}>{STATUS_LABELS[a.status]}</span>
            {a.due_date && <span className="assignee__due small muted">Due {fmtDate(a.due_date, false)}</span>}
          </div>
          <div className="assignee__actions">
            <button type="button" className="btn btn--small" disabled={busy} onClick={() => onMove(a)}>
              Move
              <span className="visually-hidden">{` ${turfName} from ${a.name} to someone else`}</span>
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger-outline"
              disabled={busy}
              onClick={() => onRemove(a)}
            >
              Remove
              <span className="visually-hidden">{` ${a.name} from ${turfName}`}</span>
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
