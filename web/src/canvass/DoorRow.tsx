import type { CSSProperties } from 'react';
import type { ContactResult, Door } from '../api/types';
import { RESULT_LABELS } from '../api/types';
import { n } from '../components/ui';
import { resultColour } from './status';

interface Props {
  door: Door;
  /** Latest result including one recorded this session but not yet round-tripped to the server. */
  result: ContactResult | null;
  onOpen: () => void;
}

export function DoorRow({ door, result, onOpen }: Props) {
  const done = result !== null;
  return (
    <li>
      <button type="button" className={`cv-door${done ? ' cv-door--done' : ''}`} data-door={door.household_id} onClick={onOpen}>
        <span className="cv-door__dot" style={{ '--dot': resultColour(result) } as CSSProperties} aria-hidden="true" />
        <span className="cv-door__text">
          <span className="cv-door__addr">{door.address}</span>
          <span className="cv-door__sub">
            {door.n_voters === 1 ? '1 voter' : `${n(door.n_voters)} voters`}
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
