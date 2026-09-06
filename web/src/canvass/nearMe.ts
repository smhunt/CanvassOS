/**
 * "Nearest first": ordering the door list by where the volunteer is actually standing.
 *
 * Walking order stays the default — it is the order the street is built for, it needs no permission
 * and no battery, and on a concession road it is simply right. Near-me is for the cases walk order
 * cannot help with: a turf picked up halfway through, a driver dropped at the far end, a door that
 * was skipped an hour ago.
 *
 * The geolocation failure handling deliberately mirrors `src/signs/geolocation.ts` — refuse before
 * asking when asking cannot work, and turn every browser error into something a volunteer outdoors
 * can act on — but is written out again rather than imported, because that module belongs to the
 * lawn-sign screen and its contract is the opposite of this one: a sign records a *fix* and must
 * never accept a cached position, while ordering a list only needs a rough idea of where you are
 * and a fifteen-second-old position is fine. Sharing the code would mean sharing the wrong defaults.
 */
import { useEffect, useRef, useState } from 'react';
import type { Door } from '../api/types';
import { coordsOf, distanceM, type Coords } from './directions';

export type DoorOrder = 'walk' | 'near';

const ORDER_KEY = 'mc-canvass.door-order';

/** The toggle is a UI preference, not field data, so localStorage is the right size of tool. */
export function readDoorOrder(): DoorOrder {
  try {
    return localStorage.getItem(ORDER_KEY) === 'near' ? 'near' : 'walk';
  } catch {
    return 'walk';
  }
}

export function writeDoorOrder(order: DoorOrder): void {
  try {
    localStorage.setItem(ORDER_KEY, order);
  } catch {
    // Private mode refuses to store; the toggle still works for this session.
  }
}

export type NearFailureKind = 'insecure' | 'unsupported' | 'denied' | 'unavailable' | 'timeout' | 'unknown';

export interface NearFailure {
  kind: NearFailureKind;
  message: string;
}

export interface NearMeState {
  at: Coords | null;
  accuracy_m: number | null;
  failure: NearFailure | null;
  pending: boolean;
}

function describe(err: GeolocationPositionError): NearFailure {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return {
        kind: 'denied',
        message:
          'Location is blocked for this site, so the doors stay in walking order. To allow it — on iPhone: Settings › Privacy & Security › Location Services, and the padlock in Safari’s address bar; on Android Chrome: tap the padlock › Permissions › Location.',
      };
    case err.POSITION_UNAVAILABLE:
      return {
        kind: 'unavailable',
        message: 'The phone could not get a fix, so the doors stay in walking order. Step away from buildings and trees and try again.',
      };
    case err.TIMEOUT:
      return {
        kind: 'timeout',
        message: 'The fix took too long, so the doors stay in walking order. A cold GPS start outdoors usually settles within a few seconds — try again.',
      };
    default:
      return {
        kind: 'unknown',
        message: `The phone reported a location error${err.message ? `: ${err.message}` : ''}. The doors stay in walking order.`,
      };
  }
}

/** Refuse before asking, when asking cannot possibly work. */
function preflight(): NearFailure | null {
  // Browsers release geolocation on https only (localhost excepted); over plain http the prompt
  // never appears and the callback errors opaquely, so say so rather than spinning.
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      kind: 'insecure',
      message:
        'This page is not on a secure (https) connection, so the browser will not release the phone’s location. Open the campaign site at its https address; the doors stay in walking order.',
    };
  }
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return {
      kind: 'unsupported',
      message: 'This browser cannot provide a location, so the doors stay in walking order.',
    };
  }
  return null;
}

/**
 * Re-sorting the whole list under the volunteer's thumb every time the GPS twitches is unusable, so
 * a new position only takes effect once it is this far from the one the list is sorted by. Ten
 * metres is well inside one rural lot frontage: the order cannot be wrong because of it, and the
 * list stops jumping while somebody stands at a door.
 */
const RESORT_THRESHOLD_M = 10;

/** A live position while near-me is on, and nothing at all — no watcher, no battery — while it is off. */
export function useNearMe(active: boolean): NearMeState {
  const [state, setState] = useState<NearMeState>({ at: null, accuracy_m: null, failure: null, pending: false });
  const anchor = useRef<Coords | null>(null);

  useEffect(() => {
    if (!active) {
      anchor.current = null;
      setState({ at: null, accuracy_m: null, failure: null, pending: false });
      return;
    }
    const blocked = preflight();
    if (blocked) {
      setState({ at: null, accuracy_m: null, failure: blocked, pending: false });
      return;
    }
    setState((s) => ({ ...s, pending: true, failure: null }));
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const next: Coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const previous = anchor.current;
        if (previous && distanceM(previous, next) < RESORT_THRESHOLD_M) {
          setState((s) => ({ ...s, pending: false }));
          return;
        }
        anchor.current = next;
        setState({
          at: next,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          failure: null,
          pending: false,
        });
      },
      (err) => setState({ at: null, accuracy_m: null, failure: describe(err), pending: false }),
      {
        enableHighAccuracy: true,
        timeout: 20_000,
        // Unlike a sign's fix, a slightly stale position is fine here — nobody walks 10 m in the
        // time it takes to open the list, and reusing one saves a cold start on every toggle.
        maximumAge: 15_000,
      },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);

  return state;
}

export interface OrderedDoors {
  doors: Door[];
  /** Metres from the device, for the rows that have a mapped position. */
  distances: Map<string, number>;
}

/**
 * Nearest first, with the unmapped doors kept in walking order at the end: plenty of rural doors
 * were never geocoded, and dropping them — or scattering them — would lose real doors off a list a
 * volunteer is using to decide the street is finished.
 */
export function orderByDistance(doors: Door[], from: Coords | null): OrderedDoors {
  const distances = new Map<string, number>();
  if (!from) return { doors, distances };
  const located: Door[] = [];
  const unlocated: Door[] = [];
  for (const d of doors) {
    const here = coordsOf(d);
    if (here) {
      distances.set(d.household_id, distanceM(from, here));
      located.push(d);
    } else {
      unlocated.push(d);
    }
  }
  located.sort((a, b) => (distances.get(a.household_id) ?? 0) - (distances.get(b.household_id) ?? 0));
  return { doors: [...located, ...unlocated], distances };
}

/** "120 m" / "1.4 km", rounded to what a phone in a pocket can honestly claim. */
export const formatDistance = (m: number): string => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
