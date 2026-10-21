import type { CSSProperties } from 'react';
import type { ContactResult, Door } from '../api/types';
import { RESULT_LABELS } from '../api/types';
import { n } from '../components/ui';
import { resultColour } from './status';

interface Props {
  door: Door;
  /** Latest result including one recorded this session but not yet round-tripped to the server. */
  result: ContactResult | null;
  /** How far the door is from the phone, when the list is ordered by distance. */
  distance?: string | null;
  onOpen: () => void;
}

export function DoorRow({ door, result, distance, onOpen }: Props) {
  const done = result !== null;
  // Everyone at this door has already voted: nothing is left to ask, so the row steps back the
  // same way a knocked door does, whether or not anybody has recorded a visit.
  const allVoted = door.n_voters > 0 && door.n_voted >= door.n_voters;
  return (
    <li>
      <button
        type="button"
        className={`cv-door${done || allVoted ? ' cv-door--done' : ''}`}
        data-door={door.household_id}
        onClick={onOpen}
      >
        <span className="cv-door__dot" style={{ '--dot': resultColour(result) } as CSSProperties} aria-hidden="true" />
        <span className="cv-door__text">
          <span className="cv-door__addr">{door.address}</span>
          <span className="cv-door__sub">
            {distance && <span className="cv-door__dist">{distance}</span>}
            {door.n_voters === 1 ? '1 voter' : `${n(door.n_voters)} voters`}
            {door.n_voted > 0 && (
              <span className="cv-voted">{allVoted ? ' · all voted' : ` · ${n(door.n_voted)} voted`}</span>
            )}
            {result && ` · ${RESULT_LABELS[result]}`}
          </span>
        </span>
        <svg className="cv-door__go" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <polyline points="9 5 16 12 9 19" />
        </svg>
      </button>
    </li>
  );
}
