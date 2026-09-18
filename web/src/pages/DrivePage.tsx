import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useDoors, useOfflineSync } from '../api/hooks';
import { DriveCard } from '../canvass/DriveCard';
import { selectAhead } from '../canvass/drive';
import { formatDistance } from '../canvass/nearMe';
import { latestResult } from '../canvass/status';
import { useDriveFix } from '../canvass/useDriveFix';
import { useOutbox, useQueuedResults } from '../offline/useOutbox';
import { ErrorBox } from '../components/ui';
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
  // Doors recorded on this phone but not yet synced, merged in so a door already knocked in a dead
  // zone isn't offered again while it sits in the outbox. That alone only covers the wait: once the
  // outbox flushes, the entry drops out of `queued`, and without useOfflineSync below the cached
  // doors query would still say last_result null, sending the driver straight back to it.
  const outbox = useOutbox();
  const queued = useQueuedResults(outbox);
  // Refreshes the doors query the moment a flush lands, so a synced result replaces the queued one
  // instead of the door reappearing between the outbox clearing and the next natural refetch.
  useOfflineSync();

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

  // A failed load is a definite answer about this turf — check it before GPS state, which is
  // irrelevant if there is no turf to drive.
  if (doors.isError) {
    const forbidden = isApiError(doors.error, 403) || isApiError(doors.error, 404);
    return (
      <div className="page page--narrow">
        <ErrorBox
          title={forbidden ? 'This turf is not assigned to you' : 'Could not load this turf'}
          error={doors.error}
          onRetry={forbidden ? undefined : () => void doors.refetch()}
        />
        <p>
          {/* list=1 stops /canvass from auto-reopening the turf that just failed — otherwise the
              only link off this page would loop straight back into the same error. */}
          <Link to="/canvass?list=1">Back to my turfs</Link>
        </p>
      </div>
    );
  }

  if (failure) return <p className="cv-note">{failure.message}</p>;
  if (doors.isPending || pending) return <p className="cv-note">Finding you…</p>;

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
