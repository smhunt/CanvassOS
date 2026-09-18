/**
 * Choosing the next door AHEAD, for someone driving rather than walking.
 *
 * Nearest-first is the wrong question at the wheel: the closest door is frequently the one just
 * passed. What matters is the along-track distance — how far ahead a door is along the line the
 * vehicle is actually travelling — and the cross-track offset, whose sign is which side of the road
 * it is on.
 *
 * This is deliberately a projection and not an angular cone. A cone cannot be right at both ends: a
 * door 40 m ahead and 25 m off the road sits 32 degrees off the heading, while the same door at
 * 400 m sits 3.6 degrees, so any fixed angle is too tight far away and too loose nearby.
 */
import type { Door } from '../api/types';
import { bearingDeg, coordsOf, distanceM, angleDiff, type Coords } from './directions';
import { orderByDistance } from './nearMe';

/** A door on a parallel concession is not "ahead". Ontario concessions are ~2 km apart, so this is safe. */
const CROSS_LIMIT_M = 150;
/** Beyond this there is nothing useful to say; it is the far end of a turf, not the next door. */
const AHEAD_MAX_M = 2000;
/**
 * The held door's own, wider band. Acquiring at 150 m and releasing at 300 m means a bend in the
 * road — which briefly widens a held door's cross-track before it straightens out again — cannot
 * drop the door and immediately re-pick it; a genuine turn onto a different road still releases it.
 * Different acquire/release thresholds are the actual definition of hysteresis; one shared number
 * would just be the flicker this function exists to prevent, moved from 150 m to wherever it sits.
 */
const HELD_CROSS_LIMIT_M = 2 * CROSS_LIMIT_M;

export interface DriveFix {
  at: Coords;
  /** Course over ground in degrees. Phones only report this while actually moving. */
  heading: number | null;
  speed_mps: number | null;
}

export interface Candidate {
  door: Door;
  along_m: number;
  cross_m: number;
  distance_m: number;
  side: 'left' | 'right' | null;
}

export interface Selection {
  current: Candidate | null;
  upcoming: Candidate[];
  /** True when there is no heading and this is plain nearest-first instead. */
  fallback: boolean;
}

function project(door: Door, fix: DriveFix, heading: number): Candidate | null {
  const here = coordsOf(door);
  if (!here) return null; // a bearing to an ungeocoded door is meaningless
  const distance_m = distanceM(fix.at, here);
  const delta = angleDiff(bearingDeg(fix.at, here), heading);
  const r = (delta * Math.PI) / 180;
  const along_m = distance_m * Math.cos(r);
  const cross_m = distance_m * Math.sin(r);
  return { door, along_m, cross_m, distance_m, side: cross_m >= 0 ? 'right' : 'left' };
}

/**
 * `held` is the household_id currently on screen. It wins whenever it is still ahead, which is the
 * whole stability story: two doors a few metres apart otherwise swap places on every GPS tick and
 * the card strobes. A held door is judged against the wider `HELD_CROSS_LIMIT_M` band (and is never
 * subject to `AHEAD_MAX_M` — a door already on screen does not stop being the right thing to show
 * just because the vehicle has driven towards it), so it survives a bend in the road; a fresh
 * candidate is always judged against the narrower `CROSS_LIMIT_M` band. The selection only moves on
 * once the held door fails its own, wider test — passed, or the vehicle has turned off its road.
 */
export function selectAhead(doors: Door[], fix: DriveFix, held: string | null): Selection {
  if (fix.heading === null) {
    const { doors: ordered, distances } = orderByDistance(doors, fix.at);
    const mapped = ordered.filter((d) => coordsOf(d) !== null);
    const toCandidate = (d: Door): Candidate => ({
      door: d,
      along_m: distances.get(d.household_id) ?? 0,
      cross_m: 0,
      distance_m: distances.get(d.household_id) ?? 0,
      side: null,
    });
    return {
      current: mapped[0] ? toCandidate(mapped[0]) : null,
      upcoming: mapped.slice(1, 4).map(toCandidate),
      fallback: true,
    };
  }

  const heading = fix.heading;
  const projected = doors.map((d) => project(d, fix, heading)).filter((c): c is Candidate => c !== null);

  const ahead = projected
    .filter((c) => c.along_m > 0 && Math.abs(c.cross_m) <= CROSS_LIMIT_M && c.along_m <= AHEAD_MAX_M)
    .sort((a, b) => a.along_m - b.along_m);

  const stillHeld = (c: Candidate) =>
    c.door.household_id === held && c.along_m > 0 && Math.abs(c.cross_m) <= HELD_CROSS_LIMIT_M;
  const heldCandidate = held ? projected.find(stillHeld) ?? null : null;
  const current = heldCandidate ?? ahead[0] ?? null;
  const upcoming = ahead.filter((c) => c.door.household_id !== current?.door.household_id).slice(0, 3);
  return { current, upcoming, fallback: false };
}
