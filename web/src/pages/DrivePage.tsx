import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useDoors, useOfflineSync } from '../api/hooks';
import { DriveCard } from '../canvass/DriveCard';
import { selectAhead } from '../canvass/drive';
import { announce, readDrivePrefs, silence, writeDrivePrefs } from '../canvass/driveSpeech';
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
  const [prefs, setPrefs] = useState(readDrivePrefs);
  const togglePref = (key: keyof typeof prefs) =>
    setPrefs((p) => {
      const next = { ...p, [key]: !p[key] };
      writeDrivePrefs(next);
      return next;
    });
  // Declared before everything it gates: the safety notice below, the speech effect further down
  // (see that effect's comment), and the two hooks on the next lines. A plain useState, not a ref:
  // the notice has to re-render to disappear when Start is tapped.
  const [seen, setSeen] = useState(readSeen);
  // Both wait for Start. Started unconditionally, the location-permission prompt lands on top of
  // "Before you drive" — the driver is answering a system dialog about a screen they have not read
  // yet — and the wake lock is requested for a page that is still just a paragraph of text.
  const { fix, failure, pending } = useDriveFix(seen);
  useWakeLock(seen);
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

  // Every door that has been in the queue at any point this drive. `useOfflineSync` is not enough on
  // its own: outbox.ts drops a flushed entry and notifies immediately, while the synced listeners
  // that invalidate this query only fire at the end of the whole flush, and the refetch is a further
  // round trip. For those several hundred milliseconds a door just recorded has last_result null and
  // no queued entry, so it reads as open again — and parked in a driveway as signal returns, that is
  // exactly the door the fallback would put back on the card and announce. A refetch that then fails
  // leaves the turf cache saying null, so without this memory the door stays on offer indefinitely.
  const everQueued = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const id of Object.keys(queued)) everQueued.current.add(id);
  }, [queued]);

  const selection = useMemo(() => {
    if (!fix || !doors.data) return null;
    // Only doors still worth driving to. The ref is read, never written, inside the memo: see the
    // comment on the `held` effect below for why that rule holds for both of them.
    const open = doors.data.doors.filter(
      (d) => latestResult(d, queued) === null && !everQueued.current.has(d.household_id),
    );
    return selectAhead(open, fix, held.current);
  }, [fix, doors.data, queued]);

  // The held door is whatever was on screen for the previous fix. It is written here, in an effect,
  // and only read inside the memo: a memo callback must stay pure — StrictMode runs it twice and
  // React may discard a result — so a ref written there would make hysteresis depend on how often
  // React happened to render.
  useEffect(() => {
    held.current = selection?.current?.door.household_id ?? null;
  }, [selection]);

  // Stop mid-sentence when the driver leaves this screen. speechSynthesis belongs to the document,
  // not to this component, so a queued utterance outlives the route change and would otherwise name
  // a door on top of whatever the volunteer went to the door screen to do.
  useEffect(() => () => silence(), []);

  // Announces only when the selected door changes, not on every GPS tick — spokenFor guards that.
  // No name is ever spoken, regardless of the names toggle, and for two separate reasons: a voice
  // carries further than a screen, and on Chrome/Android speechSynthesis may pick a REMOTE voice,
  // which sends the utterance text to a third party — the voters list is personal information under
  // the Municipal Elections Act and does not leave this stack to be read aloud.
  const spokenFor = useRef<string | null>(null);
  useEffect(() => {
    // Must wait for the safety notice to be dismissed. Without this the effect would speak while the
    // notice is still on screen and the driver hasn't tapped Start yet — and on iOS, speech synthesis
    // is blocked until a user gesture, so that first utterance is silently dropped while spokenFor
    // still records the door as announced, meaning the first door would never be spoken at all.
    if (!seen) return;
    const c = selection?.current;
    if (!c || !prefs.speak) return;
    // Nothing is ever said without a heading. A parked car needs no voice, and at a stop sign a
    // phone flips between heading:null and a noisy course several times, which would announce the
    // same door again on every flip. spokenFor is deliberately left unwritten while suppressed, so
    // the door still gets its one announcement the moment a real heading arrives.
    if (selection?.fallback) return;
    if (spokenFor.current === c.door.household_id) return;
    spokenFor.current = c.door.household_id;
    const side = c.side ? `, on your ${c.side}` : '';
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
            // Spoken from inside the tap, synchronously, for two reasons. It is the driver's
            // audible check that the phone will in fact talk to them, made while the car is still
            // parked and they can do something about it; and iOS only permits programmatic speech
            // after an utterance started inside a user gesture, so this is also what unlocks every
            // later announcement.
            if (prefs.speak) announce('Drive mode on');
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
  // `!fix` is the load-bearing half. useDriveFix starts at pending:false, so on the render right
  // after Start — and again on the render after its effect sets pending — a cached door list with no
  // fix yet would fall through to the card and flash "No more doors ahead in this turf." at a driver
  // who has not moved a metre. `failure` is already returned above, so reaching here with no fix
  // means the first position is still coming.
  if (doors.isPending || pending || !fix) return <p className="cv-note">Finding you…</p>;

  return (
    <div className="drive-screen">
      <div className="drive-bar">
        <Link to={`/canvass/${turfId}`}>Back to the list</Link>
        <button
          type="button"
          className="btn btn--small"
          aria-pressed={prefs.speak}
          onClick={() => {
            // Same two reasons as the Start button: an audible confirmation that speech is working,
            // and the user gesture iOS requires before it will speak on its own afterwards. Said
            // here, synchronously, rather than from an effect — an effect runs after the gesture has
            // ended and iOS has already closed the window.
            if (!prefs.speak) announce('Speech on');
            togglePref('speak');
          }}
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
