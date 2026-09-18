import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useDoors, useOfflineSync } from '../api/hooks';
import { DriveCard } from '../canvass/DriveCard';
import { selectAhead } from '../canvass/drive';
import { announce, readDrivePrefs, writeDrivePrefs } from '../canvass/driveSpeech';
import { formatDistance } from '../canvass/nearMe';
import { latestResult } from '../canvass/status';
import { useDriveFix } from '../canvass/useDriveFix';
import { useWakeLock } from '../canvass/useWakeLock';
import { useOutbox, useQueuedResults } from '../offline/useOutbox';
import { ErrorBox } from '../components/ui';
// .cv-note lives in canvass.css, which is imported per page rather than globally. Without this a
// reload or a deep link on this route — a PWA reopening mid-drive — renders the banner unstyled.
import '../canvass/canvass.css';
import '../canvass/drive.css';

// Shown once per device before the first door ever appears. Local to this page, in the style of
// readDrivePrefs in driveSpeech.ts: a read that fails means "not seen" (show the notice again rather
// than skip a safety warning), a write that fails is ignored (private mode; the notice just reappears
// next launch, which is a safe failure mode here).
const SEEN_KEY = 'mc-canvass.drive-seen';

function readSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Private mode refuses to store; the notice just shows again next time, which is safe.
  }
}

export function DrivePage() {
  const { turfId } = useParams();
  const doors = useDoors(turfId);
  const { fix, failure, pending } = useDriveFix(true);
  useWakeLock(true);
  const [prefs, setPrefs] = useState(readDrivePrefs);
  const togglePref = (key: keyof typeof prefs) =>
    setPrefs((p) => {
      const next = { ...p, [key]: !p[key] };
      writeDrivePrefs(next);
      return next;
    });
  // Gates both the safety notice below and the speech effect further down — see that effect's
  // comment for why speech must wait for it too. A plain useState, not a ref: the notice has to
  // re-render to disappear when Start is tapped.
  const [seen, setSeen] = useState(readSeen);
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

  // Announces only when the selected door changes, not on every GPS tick — spokenFor guards that.
  // No name is ever spoken, regardless of the names toggle: a voice carries further than a screen.
  const spokenFor = useRef<string | null>(null);
  useEffect(() => {
    // Must wait for the safety notice to be dismissed. Without this the effect would speak while the
    // notice is still on screen and the driver hasn't tapped Start yet — and on iOS, speech synthesis
    // is blocked until a user gesture, so that first utterance is silently dropped while spokenFor
    // still records the door as announced, meaning the first door would never be spoken at all.
    if (!seen) return;
    const c = selection?.current;
    if (!c || !prefs.speak) return;
    if (spokenFor.current === c.door.household_id) return;
    spokenFor.current = c.door.household_id;
    const side = c.side && !selection?.fallback ? `, on your ${c.side}` : '';
    announce(`Next door, ${Math.round(c.distance_m / 10) * 10} metres${side}`);
  }, [selection, prefs.speak, seen]);

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

  // Shown once per device, before GPS state or the doors query is even consulted — a driver reads
  // this and taps Start before anything else on this screen matters.
  if (!seen) {
    return (
      <div className="page page--narrow">
        <h1>Before you drive</h1>
        <p>
          Mount your phone before you drive. This screen updates itself — you should never need to
          touch it while the car is moving, and in Ontario handling a phone while driving is an
          offence. Drive on a charger: continuous GPS with the screen on is heavy on the battery.
        </p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            writeSeen();
            setSeen(true);
          }}
        >
          Start
        </button>
      </div>
    );
  }

  if (failure) return <p className="cv-note">{failure.message}</p>;
  if (doors.isPending || pending) return <p className="cv-note">Finding you…</p>;

  return (
    <div className="drive-screen">
      <div className="drive-bar">
        <Link to={`/canvass/${turfId}`}>Back to the list</Link>
        <button
          type="button"
          className="btn btn--small"
          aria-pressed={prefs.speak}
          onClick={() => togglePref('speak')}
        >
          {prefs.speak ? 'Speech: on' : 'Speech: off'}
        </button>
        <button
          type="button"
          className="btn btn--small"
          aria-pressed={prefs.names}
          onClick={() => togglePref('names')}
        >
          {prefs.names ? 'Names: on' : 'Names: off'}
        </button>
      </div>
      {selection?.current ? (
        <DriveCard c={selection.current} showNames={prefs.names} fallback={selection.fallback} />
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
