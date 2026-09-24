/**
 * The one set of things you can do at a door — wherever that door is shown.
 *
 * Before this existed each screen grew its own row of buttons, and they drifted: the map card could
 * record a visit and place a sign, the door screen could record a visit and walk there, the
 * follow-up queue could only send you back to the map. Which actions a canvasser had depended on
 * how they had happened to arrive at the same house, which is not a distinction anybody can hold in
 * their head on a porch. So the set lives here once and the screens embed it.
 *
 * Where an action is genuinely impossible it is **disabled with the reason on it**, never hidden:
 * a missing button reads as "this app cannot do that", a greyed one reads as "not at this door",
 * and only the second is true.
 *
 * Deliberately NOT used by drive mode (`pages/DrivePage.tsx`). That screen is built so the driver
 * never touches it while the car is moving — handling a phone while driving is an offence in
 * Ontario, and its own onboarding text promises it updates itself. Per-door buttons there would be
 * a safety regression dressed up as consistency. The driver reaches this set from "Back to the
 * list". Do not "fix" the inconsistency.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useHousehold, usePlaceSign, useSigns } from '../api/hooks';
import { RESULT_LABELS, type ContactResult, type Voter } from '../api/types';
import { ErrorBox, Spinner } from '../components/ui';
import { useOutbox } from '../offline/useOutbox';
import { coordsOf, mapsUrl } from './directions';
import { RecordVisit } from './RecordVisit';
import { signRequestVerdict } from './signRequest';

/** The least a screen has to know about a door to offer the full set. */
export interface ActionDoor {
  id: string;
  address: string;
  lat: number | null;
  lon: number | null;
  /** The turf this door is in, when the caller knows of one. Null is normal and is stored as null. */
  turfId: string | null;
  /**
   * The names on the list here, when the caller already has them. A list row (the follow-up queue,
   * the delivery list) does not, so recording a visit from there fetches the door on demand rather
   * than sending the canvasser off to another screen to do the same thing.
   */
  voters?: Voter[];
}

/**
 * Actions the host screen already presents in a richer, dedicated form, so this row does not print
 * them twice.
 *
 * This is an explicit declaration, not a way to trim the set: the actions a canvasser can REACH on
 * that screen must still be all of them. Two callers use it. The door screen's footer is the five
 * one-thumb result buttons, and its "Walk here" carries a distance and a compass point this row has
 * no room for. The delivery list makes placing a sign its primary button, because on that screen
 * delivering one is the entire job.
 */
export type ProvidedAction = 'visit' | 'directions' | 'place';

interface Props {
  door: ActionDoor;
  provided?: ProvidedAction[];
  /**
   * A visit has just been recorded. Only for refetches the HOST owns — the map card repaints its
   * own point and status line. The row reports the result itself, so nothing here has to render.
   */
  onRecorded?: (result: ContactResult) => void;
}

/**
 * There is deliberately no `compact` prop. Every host wraps this row in its own container
 * (`.hc-actions` here, `.rep-fu__actions`, `.sg-row__actions`), and those already carry the density
 * each screen needs — including the `min-height: var(--tap)` a phone gets. A size modifier here
 * would be a fourth way to say the same thing, and the first step towards the set differing by
 * screen again.
 */
export function HouseholdActions({ door, provided = [], onRecorded }: Props) {
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<ContactResult | null>(null);
  const [requested, setRequested] = useState<{ queued: boolean } | null>(null);
  const place = usePlaceSign();

  // Subscribing starts the outbox, so a request raised here flushes without depending on which
  // screen it was raised from. `SignOutButton` in the shell already does this app-wide, but this
  // component must not rely on some other component being mounted above it.
  useOutbox();

  // Shared cache with the signs map (`useSigns()` with no filters is the same query key), so this
  // is usually free. `undefined` — loading, offline, refused — means the guard fails open.
  const signs = useSigns();
  const verdict = signRequestVerdict(door, signs.data);

  // Only fetched when a list row asked for the visit form without carrying the names. Scoped by the
  // API, not by this flag: `/households/:id` runs assertHouseholdAccess, so a volunteer reaching a
  // door outside their turfs gets a 403 here exactly as they would anywhere else.
  const needVoters = recording && !door.voters;
  const fetched = useHousehold(needVoters ? door.id : null, needVoters);

  const coords = coordsOf(door);
  const btn = 'btn btn--small';

  function requestSign() {
    if (!verdict.can || !coords) return;
    // One client_id, minted once, right here. Regenerating it on a retry is what turns one request
    // into two; `usePlaceSign` hands this exact body to the outbox and replays it unchanged.
    place.mutate(
      {
        household_id: door.id,
        lat: coords.lat,
        lon: coords.lon,
        status: 'requested',
        label: door.address,
        client_id: crypto.randomUUID(),
      },
      { onSuccess: (r) => setRequested({ queued: r.queued }) },
    );
  }

  if (recording) {
    const voters = door.voters ?? fetched.data?.voters;
    if (!voters) {
      return (
        <div className="hc-actions">
          {fetched.isPending && <Spinner size={16} />}
          {fetched.isError && <ErrorBox title="Could not open this door" error={fetched.error} compact />}
          <button type="button" className={btn} onClick={() => setRecording(false)}>
            Cancel
          </button>
        </div>
      );
    }
    return (
      <RecordVisit
        householdId={door.id}
        address={door.address}
        voters={voters}
        turfId={door.turfId}
        onRecorded={(r) => {
          setRecording(false);
          setRecorded(r);
          onRecorded?.(r);
        }}
        onCancel={() => setRecording(false)}
      />
    );
  }

  return (
    <div className="hc-actions">
      {recorded && (
        <p className="hc-actions__note" role="status">
          Recorded: <strong>{RESULT_LABELS[recorded]}</strong>.
        </p>
      )}
      {requested && (
        <p className="hc-actions__note" role="status">
          {/* A queued write has NOT been recorded, and saying otherwise to somebody about to walk
              away is the whole bug the outbox exists to avoid. */}
          {requested.queued
            ? 'Sign requested — saved on this phone and waiting for signal.'
            : 'Sign requested. It shows as Requested on the signs map and on the delivery list.'}
        </p>
      )}

      {!provided.includes('visit') && (
        // `contact.turf_id` is nullable, which is what makes this work at a door in no turf at all.
        <button type="button" className={`${btn} btn--primary`} onClick={() => setRecording(true)}>
          Record a visit
        </button>
      )}

      <button
        type="button"
        className={btn}
        onClick={requestSign}
        disabled={!verdict.can || place.isPending || requested !== null}
        title={verdict.can ? undefined : verdict.reason}
      >
        {place.isPending ? <Spinner size={14} /> : null}
        Request a sign
      </button>

      {/* Placing is the field flow — it wants a GPS fix and a photo — so it stays a link to the
          screen built for it, carrying the door through. */}
      {!provided.includes('place') && (
        <Link
          className={btn}
          to={`/signs?tab=place&household=${encodeURIComponent(door.id)}&address=${encodeURIComponent(door.address)}`}
        >
          Place a lawn sign
        </Link>
      )}

      {door.turfId && (
        <Link className={btn} to={`/canvass/${door.turfId}`}>
          Open in the door screen
        </Link>
      )}

      {!provided.includes('directions') &&
        (coords ? (
          // The phone's own map app, because the last hundred metres of a rural lane is not
          // something this app is going to do better than Apple or Google. New tab so a mis-tap
          // cannot lose an unsaved door behind a navigation.
          <a className={btn} href={mapsUrl(coords.lat, coords.lon)} target="_blank" rel="noreferrer noopener">
            Directions
          </a>
        ) : (
          <button type="button" className={btn} disabled title="This door has no map position.">
            Directions
          </button>
        ))}

      {!verdict.can && (
        <p className="hc-actions__note muted small">{verdict.reason}</p>
      )}
      {place.isError && <ErrorBox title="Could not record this sign request" error={place.error} compact />}
    </div>
  );
}
