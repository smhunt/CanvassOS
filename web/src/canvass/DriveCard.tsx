import type { Candidate } from './drive';
import { formatDistance } from './nearMe';
import { resultColour } from './status';

export function DriveCard({ c, showNames, fallback }: { c: Candidate; showNames: boolean; fallback: boolean }) {
  // display_name is what the rest of the app shows; do not re-derive it from the name parts.
  const names = c.door.voters.map((v) => v.display_name).join(', ');
  return (
    <div className="drive-card" style={{ borderColor: resultColour(c.door.last_result) }}>
      <div className="drive-distance">{formatDistance(c.distance_m)}</div>
      <div className="drive-address">{c.door.address}</div>
      {c.side && !fallback ? <div className="drive-side">on your {c.side}</div> : null}
      {showNames && names ? <div className="drive-names">{names}</div> : null}
      <div className="drive-count">{c.door.n_voters} on the list</div>
    </div>
  );
}
