import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDoors } from '../api/hooks';
import { DriveCard } from '../canvass/DriveCard';
import { selectAhead } from '../canvass/drive';
import { formatDistance } from '../canvass/nearMe';
import { latestResult } from '../canvass/status';
import { useDriveFix } from '../canvass/useDriveFix';
import { useOutbox, useQueuedResults } from '../offline/useOutbox';
// .cv-note lives in canvass.css, which is imported per page rather than globally. Without this a
// reload or a deep link on this route — a PWA reopening mid-drive — renders the banner unstyled.
import '../canvass/canvass.css';
import '../canvass/drive.css';

export function DrivePage() {
  const { turfId } = useParams();
  const doors = useDoors(turfId);
  const { fix, failure, pending } = useDriveFix(true);
  const [showNames, setShowNames] = useState(true);
  const held = useRef<string | null>(null);
  // Doors recorded on this phone but not yet synced. Without this a door knocked in a dead zone
  // keeps last_result = null, and drive mode would send the driver straight back to it.
  const outbox = useOutbox();
  const queued = useQueuedResults(outbox);

  const selection = useMemo(() => {
    if (!fix || !doors.data) return null;
    // Only doors still worth driving to.
    const open = doors.data.doors.filter((d) => latestResult(d, queued) === null);
    return selectAhead(open, fix, held.current);
  }, [fix, doors.data, queued]);

  // The held door is whatever was on screen for the previous fix. It is written here, in an effect,
  // and only read inside the memo: a memo callback must stay pure — StrictMode runs it twice and
  // React may discard a result — so a ref written there would make hysteresis depend on how often
  // React happened to render.
  useEffect(() => {
    held.current = selection?.current?.door.household_id ?? null;
  }, [selection]);

  if (failure) return <p className="cv-note">{failure.message}</p>;
  if (doors.isLoading || pending) return <p className="cv-note">Finding you…</p>;

  return (
    <div className="drive-screen">
      <div className="drive-bar">
        <Link to={`/canvass/${turfId}`}>Back to the list</Link>
        <button type="button" onClick={() => setShowNames((v) => !v)}>
          {showNames ? 'Hide names' : 'Show names'}
        </button>
      </div>
      {selection?.current ? (
        <DriveCard c={selection.current} showNames={showNames} fallback={selection.fallback} />
      ) : (
        <p className="cv-note">No more doors ahead in this turf.</p>
      )}
      {selection?.fallback ? <p className="drive-hint">Pointing unknown — showing nearest first.</p> : null}
      <ul className="drive-upcoming">
        {selection?.upcoming.map((u) => (
          <li key={u.door.household_id}>
            {formatDistance(u.distance_m)} · {u.door.address}
          </li>
        ))}
      </ul>
    </div>
  );
}
