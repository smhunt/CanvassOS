# Drive Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A glanceable screen that continuously names the next voter door *ahead in the direction of travel*, so a candidate driving a rural turf is told what is coming rather than what is nearest.

**Architecture:** A new lazy-loaded route `/canvass/:turfId/drive`. The maths lives in a pure module (`drive.ts`) that projects each door onto the direction of travel — along-track distance decides what is ahead, cross-track sign decides which side of the road — with hysteresis so the selection cannot strobe. A drive-tuned `watchPosition` hook feeds it. **No API change:** `useDoors` already serves position and status, already caches per turf for offline, and volunteers are already turf-scoped.

**Tech Stack:** React 18 + TypeScript, react-router 6, TanStack Query, plain CSS. Tests run under `node:test` via `tsx`, mirroring the `api` package. Browser APIs: Geolocation, Screen Wake Lock, SpeechSynthesis.

**Spec:** `docs/superpowers/specs/2026-09-18-drive-mode-design.md`

## Global Constraints

- **No Prettier, no ESLint. Never run them.** Match surrounding style by hand: single quotes, ~100 char lines.
- Comments explain **why** (the legal rule, the pg quirk, the browser quirk), never what. Match the existing density.
- **Only four breakpoints exist** (`web/src/styles.css`): phone unqualified, compact `max-width: 479.98px`, tablet `min-width: 720px`, desktop `min-width: 1100px`; plus `and (min-height: 600px)` for two-pane and `(orientation: landscape) and (max-height: 500px)` for a phone on its side. **A fifth number is a bug.**
- **Before adding any CSS rule, grep for the selector.** Duplicate declarations have caused two real bugs in this repo.
- `localStorage` is for UI preferences only, always in try/catch.
- Relative imports in `.ts`/`.tsx` do **not** carry `.js` in the web package (that rule is the API's ESM/NodeNext contract, not this one). Match neighbouring files.
- Commits are small and typed: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- `CROSS_LIMIT_M = 150`. `AHEAD_MAX_M = 2000`. `HELD_CROSS_LIMIT_M = 2 * CROSS_LIMIT_M` (a held door's wider release band).

## Controller rulings that amend this plan

Made during execution; each is recorded with its reasoning in the SDD ledger. Where a task's text
below still disagrees with one of these, the ruling is the requirement.

1. The web test script is `tsx --test src/canvass/*.test.ts` — npm runs scripts under `sh`, which has no globstar.
2. `angleDiff` returns (-180, 180] exactly as the spec says; the plan's first formula returned [-180, 180).
3. `DrivePage` filters open doors with `latestResult(d, queued)`, merging the offline outbox the way `DoorScreen` does — a door knocked in a dead zone must not be offered again.
4. A held door is looked up outside the fresh-candidate filter and survives to `HELD_CROSS_LIMIT_M` (300 m); `AHEAD_MAX_M` does not apply to it. Task 2's code block below predates this — the committed `drive.ts` is authoritative.
5. There is no `metres()`; distance formatting reuses the existing `formatDistance` from `nearMe.ts`.
6. `DrivePage` imports `canvass.css` as well as `drive.css` — `.cv-note` lives there and that stylesheet is per-page, not global, so a reload on the drive route would otherwise lose it.
7. `DrivePage`'s `useMemo` only reads `held.current`; a `useEffect` writes it. A memo callback must stay pure.
8. Task 5's speech effect reads `selection?.fallback` — TypeScript does not narrow `selection` from a check on `c = selection?.current`, so the plain form fails under `strict`.
9. `DrivePage` calls `useOfflineSync()`. Ruling 3 alone was incomplete: after the outbox flushes, the entry leaves `queued` while the cached doors query still says `last_result: null`, so the door came back.
10. `DrivePage` has `DoorScreen`'s error branch for the doors query, first among its early returns — a failed load must never read as "No more doors ahead". Task 4's code block below predates rulings 9 and 10; the committed `DrivePage.tsx` is authoritative.
11. The card's `resultColour` stays although it is constant under today's null-only filter. Whether drive mode should also offer "not home" revisits is a product question left to the candidate.
12. The error branch duplicated between `DrivePage` and `DoorScreen` stands on this branch, parked as a follow-up: extracting it means refactoring the live door screen five weeks before the election to save ~15 lines.
13. `useWakeLock` re-checks after `await request()` whether it was already cleaned up, and releases at once if so. Task 5's sample below predates this and could leak a lock under StrictMode; the committed file is authoritative.
14. The two toggles use state labels ("Speech: on/off", "Names: on/off") with `aria-pressed`, not verb labels, which read backwards to assistive technology.

## File Structure

| File | Responsibility |
|---|---|
| `web/src/canvass/directions.ts` (modify) | Gains `bearingDeg` + `angleDiff`; `compassOf` refactored to use `bearingDeg` so there is one bearing implementation |
| `web/src/canvass/drive.ts` (create) | Pure selection maths: along/cross-track, filtering, hysteresis. No React, no browser APIs |
| `web/src/canvass/drive.test.ts` (create) | Unit tests for the above. No DOM, no network |
| `web/src/canvass/useDriveFix.ts` (create) | `watchPosition` tuned for a vehicle; yields position + heading + speed |
| `web/src/canvass/useWakeLock.ts` (create) | Screen Wake Lock acquire/re-acquire/release |
| `web/src/canvass/driveSpeech.ts` (create) | One-shot announcement + the persisted speech/names preferences |
| `web/src/canvass/DriveCard.tsx` (create) | The glanceable card itself |
| `web/src/pages/DrivePage.tsx` (create) | Route shell: wires `useDoors` + fix + selection + card, owns the interstitial |
| `web/src/canvass/drive.css` (create) | Card styling, imported by `DrivePage` |
| `web/src/App.tsx` (modify) | Register the lazy route |
| `web/src/pages/DoorScreen.tsx` (modify) | "Drive" entry button |

---

### Task 1: Bearing maths, and a test path for the web package

The web package has **no test runner today** — `web/package.json` has only `dev`, `build`, `preview`, `typecheck`. This task establishes one, because everything downstream depends on it. We mirror the `api` package (`tsx --test`) rather than adding a new framework.

**Files:**
- Modify: `web/package.json` (add `tsx` devDependency + `test` script)
- Modify: `web/src/canvass/directions.ts`
- Test: `web/src/canvass/drive.test.ts`

**Interfaces:**
- Consumes: `Coords` from `./directions` (already exported).
- Produces: `bearingDeg(a: Coords, b: Coords): number` (0–360, 0 = true north); `angleDiff(a: number, b: number): number` (signed, in `(-180, 180]`).

- [ ] **Step 1: Add the test runner**

```bash
cd web && npm install --save-dev tsx
```

Then add to `web/package.json` scripts, matching the api package's form:

```json
"test": "tsx --test src/**/*.test.ts"
```

- [ ] **Step 2: Write the failing test**

Create `web/src/canvass/drive.test.ts`:

```ts
/** Unit tests for the drive-mode maths (no DOM, no network). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { angleDiff, bearingDeg, compassOf, type Coords } from './directions';

const at = (lat: number, lon: number): Coords => ({ lat, lon });

describe('bearingDeg', () => {
  it('reads the cardinal directions', () => {
    const origin = at(43.0, -81.5);
    assert.ok(Math.abs(bearingDeg(origin, at(43.1, -81.5)) - 0) < 0.5);
    assert.ok(Math.abs(bearingDeg(origin, at(43.0, -81.4)) - 90) < 0.5);
    assert.ok(Math.abs(bearingDeg(origin, at(42.9, -81.5)) - 180) < 0.5);
    assert.ok(Math.abs(bearingDeg(origin, at(43.0, -81.6)) - 270) < 0.5);
  });

  it('always returns 0..360, never negative', () => {
    const b = bearingDeg(at(43.0, -81.5), at(43.0, -81.6));
    assert.ok(b >= 0 && b < 360);
  });
});

describe('compassOf still behaves after the extraction', () => {
  it('rounds to the same eight points as before', () => {
    const origin = at(43.0, -81.5);
    assert.equal(compassOf(origin, at(43.1, -81.5)), 'N');
    assert.equal(compassOf(origin, at(43.0, -81.4)), 'E');
    assert.equal(compassOf(origin, at(42.9, -81.5)), 'S');
    assert.equal(compassOf(origin, at(43.0, -81.6)), 'W');
  });
});

describe('angleDiff', () => {
  // The wraparound is where this class of bug always lives.
  it('is signed and takes the short way round 0/360', () => {
    assert.equal(angleDiff(10, 350), 20);
    assert.equal(angleDiff(350, 10), -20);
    assert.equal(angleDiff(0, 0), 0);
    assert.equal(angleDiff(0, 180), 180);
    assert.equal(angleDiff(180, 0), 180);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd web && npm test`
Expected: FAIL — `bearingDeg` and `angleDiff` are not exported from `./directions`.

- [ ] **Step 4: Implement**

In `web/src/canvass/directions.ts`, add below `distanceM` and rewrite `compassOf` to use it:

```ts
/**
 * Initial great-circle bearing in degrees, 0 = true north. Drive mode needs the number, so this is
 * the one implementation and compassOf rounds its result — an eight-point string and a heading
 * comparison must never disagree about which way a door is.
 */
export function bearingDeg(a: Coords, b: Coords): number {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Signed difference a - b, wrapped to (-180, 180]. Positive means a is clockwise of b. */
export function angleDiff(a: number, b: number): number {
  // Not the obvious `((d % 360) + 540) % 360 - 180`: that returns -180 for the antipodal case, i.e.
  // [-180, 180), the mirror image of the range documented above and stated in the spec.
  return 180 - ((((180 - (a - b)) % 360) + 360) % 360);
}
```

Replace the body of `compassOf` with:

```ts
export function compassOf(a: Coords, b: Coords): string {
  return COMPASS[Math.round(bearingDeg(a, b) / 45) % 8] as string;
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd web && npm test && npm run typecheck`
Expected: PASS, and no type errors anywhere that used `compassOf`.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/canvass/directions.ts web/src/canvass/drive.test.ts
git commit -m "refactor: extract bearingDeg so drive mode and compassOf share one implementation"
```

---

### Task 2: Selection maths with hysteresis

**Files:**
- Create: `web/src/canvass/drive.ts`
- Modify: `web/src/canvass/drive.test.ts`

**Interfaces:**
- Consumes: `bearingDeg`, `angleDiff`, `distanceM`, `coordsOf`, `Coords` from `./directions`; `Door` from `../api/types`; `orderByDistance` from `./nearMe`.
- Produces:
  - `interface DriveFix { at: Coords; heading: number | null; speed_mps: number | null }`
  - `interface Candidate { door: Door; along_m: number; cross_m: number; distance_m: number; side: 'left' | 'right' | null }`
  - `interface Selection { current: Candidate | null; upcoming: Candidate[]; fallback: boolean }`
  - `selectAhead(doors: Door[], fix: DriveFix, held: string | null): Selection`

- [ ] **Step 1: Write the failing tests**

Append to `web/src/canvass/drive.test.ts`:

```ts
import { selectAhead, type DriveFix } from './drive';
import type { Door } from '../api/types';

// ~111 m per 0.001 degree of latitude at this latitude; enough for readable fixtures.
const door = (id: string, lat: number, lon: number): Door => ({
  household_id: id,
  address: `${id} Road`,
  community: null,
  ward: '1',
  lat,
  lon,
  n_voters: 1,
  walk_order: 0,
  last_result: null,
  last_contact_at: null,
  voters: [],
});

const northbound = (lat: number, lon: number): DriveFix => ({ at: { lat, lon }, heading: 0, speed_mps: 22 });

describe('selectAhead', () => {
  it('ignores a nearer door that is behind, and picks the one ahead', () => {
    const behind = door('behind', 42.999, -81.5);
    const ahead = door('ahead', 43.002, -81.5);
    const sel = selectAhead([behind, ahead], northbound(43.0, -81.5), null);
    assert.equal(sel.current?.door.household_id, 'ahead');
    assert.ok(sel.current!.along_m > 0);
  });

  it('names the side of the road from the sign of cross-track', () => {
    const right = door('right', 43.002, -81.4985);
    const left = door('left', 43.002, -81.5015);
    assert.equal(selectAhead([right], northbound(43.0, -81.5), null).current?.side, 'right');
    assert.equal(selectAhead([left], northbound(43.0, -81.5), null).current?.side, 'left');
  });

  it('rejects a door on a parallel road beyond CROSS_LIMIT_M', () => {
    const parallel = door('parallel', 43.002, -81.49);
    const sel = selectAhead([parallel], northbound(43.0, -81.5), null);
    assert.equal(sel.current, null);
  });

  it('holds the selection while the held door is still ahead', () => {
    const a = door('a', 43.0020, -81.5);
    const b = door('b', 43.0021, -81.5);
    // b is nearly as close; without hysteresis the pick would flip between ticks.
    const sel = selectAhead([a, b], northbound(43.0, -81.5), 'b');
    assert.equal(sel.current?.door.household_id, 'b');
  });

  it('releases the held door once it has been passed', () => {
    const passed = door('passed', 42.999, -81.5);
    const next = door('next', 43.002, -81.5);
    const sel = selectAhead([passed, next], northbound(43.0, -81.5), 'passed');
    assert.equal(sel.current?.door.household_id, 'next');
  });

  it('falls back to nearest-first when the phone reports no heading', () => {
    const near = door('near', 42.9995, -81.5);
    const far = door('far', 43.010, -81.5);
    const sel = selectAhead([near, far], { at: { lat: 43.0, lon: -81.5 }, heading: null, speed_mps: null }, null);
    assert.equal(sel.fallback, true);
    assert.equal(sel.current?.door.household_id, 'near');
  });

  it('skips doors that were never geocoded', () => {
    const unmapped = { ...door('unmapped', 0, 0), lat: null, lon: null } as Door;
    const ahead = door('ahead', 43.002, -81.5);
    const sel = selectAhead([unmapped, ahead], northbound(43.0, -81.5), null);
    assert.equal(sel.current?.door.household_id, 'ahead');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && npm test`
Expected: FAIL — `./drive` does not exist.

- [ ] **Step 3: Implement**

Create `web/src/canvass/drive.ts`:

```ts
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
 * the card strobes. The selection only moves on once the held door has been passed.
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

  const ahead: Candidate[] = [];
  for (const d of doors) {
    const c = project(d, fix, fix.heading);
    if (!c) continue;
    if (c.along_m <= 0) continue;
    if (Math.abs(c.cross_m) > CROSS_LIMIT_M) continue;
    if (c.along_m > AHEAD_MAX_M) continue;
    ahead.push(c);
  }
  ahead.sort((a, b) => a.along_m - b.along_m);

  const heldCandidate = held ? ahead.find((c) => c.door.household_id === held) ?? null : null;
  const current = heldCandidate ?? ahead[0] ?? null;
  const upcoming = ahead.filter((c) => c.door.household_id !== current?.door.household_id).slice(0, 3);
  return { current, upcoming, fallback: false };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd web && npm test`
Expected: PASS — all of Task 1's and Task 2's cases.

- [ ] **Step 5: Commit**

```bash
git add web/src/canvass/drive.ts web/src/canvass/drive.test.ts
git commit -m "feat(drive): pick the next door ahead by along-track distance, with hysteresis"
```

---

### Task 3: The position feed

**Files:**
- Create: `web/src/canvass/useDriveFix.ts`

**Interfaces:**
- Consumes: `DriveFix` from `./drive`; `NearFailure` from `./nearMe` (already exported).
- Produces: `useDriveFix(active: boolean): { fix: DriveFix | null; failure: NearFailure | null; pending: boolean }`

- [ ] **Step 1: Export the two helpers from `nearMe.ts` first**

`useDriveFix` imports these, so they must exist before the file that imports them or Step 2 will not
compile. `nearMe.ts` currently keeps `describe` and `preflight` module-private. Rename and export
them, and update the two call sites inside `nearMe.ts` to the new names. Drive mode must not write
the failure copy a third time — that copy is the valuable part and must not fork:

```ts
export function describeGeolocationFailure(err: GeolocationPositionError): NearFailure { /* existing body of describe */ }
export function preflightGeolocation(): NearFailure | null { /* existing body of preflight */ }
```

- [ ] **Step 2: Implement the hook**

There is no unit test here: this is a thin wrapper over a browser API that jsdom does not meaningfully emulate, and the logic worth testing was already extracted into `drive.ts`. It is verified by the field test in Task 6.

Create `web/src/canvass/useDriveFix.ts`:

```ts
/**
 * A position feed tuned for a moving vehicle.
 *
 * This deliberately does not reuse useNearMe, for the same reason nearMe.ts declined to reuse
 * signs/geolocation.ts and said so: the defaults are opposite. Near-me accepts a fifteen-second-old
 * position because nobody walks 10 m while a list opens. At 80 km/h a fifteen-second-old position is
 * 330 m stale and points at the wrong door, so nothing cached is acceptable here. Near-me's 10 m
 * re-sort threshold is dropped entirely — at speed it is crossed twice a second, and stability comes
 * from the hysteresis in drive.ts, not from ignoring movement.
 */
import { useEffect, useState } from 'react';
import type { DriveFix } from './drive';
import { describeGeolocationFailure, preflightGeolocation, type NearFailure } from './nearMe';

export interface DriveFixState {
  fix: DriveFix | null;
  failure: NearFailure | null;
  pending: boolean;
}

export function useDriveFix(active: boolean): DriveFixState {
  const [state, setState] = useState<DriveFixState>({ fix: null, failure: null, pending: false });

  useEffect(() => {
    if (!active) {
      setState({ fix: null, failure: null, pending: false });
      return;
    }
    const blocked = preflightGeolocation();
    if (blocked) {
      setState({ fix: null, failure: blocked, pending: false });
      return;
    }
    setState((s) => ({ ...s, pending: true, failure: null }));
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setState({
          fix: {
            at: { lat: pos.coords.latitude, lon: pos.coords.longitude },
            // null when stationary, and on desktops that have no course at all — drive.ts falls
            // back to nearest-first rather than showing an empty card.
            heading: Number.isFinite(pos.coords.heading) ? (pos.coords.heading as number) : null,
            speed_mps: Number.isFinite(pos.coords.speed) ? (pos.coords.speed as number) : null,
          },
          failure: null,
          pending: false,
        });
      },
      (err) => setState({ fix: null, failure: describeGeolocationFailure(err), pending: false }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);

  return state;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npm run typecheck && npm test`
Expected: no errors; Task 1–2 tests still pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/canvass/useDriveFix.ts web/src/canvass/nearMe.ts
git commit -m "feat(drive): a position feed tuned for a vehicle, sharing near-me's failure copy"
```

---

### Task 4: The card and the route

**Files:**
- Create: `web/src/canvass/DriveCard.tsx`, `web/src/canvass/drive.css`, `web/src/pages/DrivePage.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `Selection`, `Candidate` from `./drive`; `useDriveFix`; `useDoors` from `../api/hooks`; `resultColour` from `./status`.
- Produces: route `/canvass/:turfId/drive`.

- [ ] **Step 1: Write the card**

Create `web/src/canvass/DriveCard.tsx`:

```tsx
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
```

- [ ] **Step 2: Write the page**

Create `web/src/pages/DrivePage.tsx`. It owns the held-door state, which is what makes hysteresis work across renders:

```tsx
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
```

- [ ] **Step 3: Register the route**

In `web/src/App.tsx`, add beside the other lazy imports:

```tsx
const DrivePage = lazy(() => import('./pages/DrivePage').then((m) => ({ default: m.DrivePage })));
```

and, immediately after the `/canvass/:turfId` route, matching its exact shape:

```tsx
<Route
  path="/canvass/:turfId/drive"
  element={
    <Suspense fallback={<LoadingList rows={1} label="Starting drive mode…" />}>
      <DrivePage />
    </Suspense>
  }
/>
```

- [ ] **Step 4: Write the CSS**

**Grep first:** `grep -rn "drive-" web/src/*.css web/src/canvass/*.css` must return nothing before you add these.

Create `web/src/canvass/drive.css`. Type is large because this is read at a glance from a mount:

```css
/* Drive mode. Read from a phone in a windscreen mount, so everything is one size larger than the
   rest of the app and the card carries the whole message without scrolling. */
.drive-screen { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.drive-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.drive-card { border: 3px solid; border-radius: 12px; padding: 20px; }
.drive-distance { font-size: 3rem; font-weight: 700; line-height: 1; }
.drive-address { font-size: 1.5rem; margin-top: 8px; }
.drive-side { font-size: 1.25rem; margin-top: 4px; }
.drive-names { font-size: 1.1rem; margin-top: 8px; }
.drive-count, .drive-hint { font-size: 0.95rem; opacity: 0.75; margin-top: 8px; }
.drive-upcoming { list-style: none; padding: 0; margin: 0; font-size: 0.95rem; opacity: 0.8; }
.drive-upcoming li { padding: 4px 0; }

/* A car mount is usually landscape, and this is the stop that already exists for it. Do not add a
   new breakpoint: put the card and the upcoming list side by side instead of stacking. */
@media (orientation: landscape) and (max-height: 500px) {
  .drive-screen { flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
  .drive-card { flex: 1 1 60%; }
  .drive-upcoming { flex: 1 1 30%; }
  .drive-distance { font-size: 2.25rem; }
}
```

- [ ] **Step 5: Verify it builds and renders**

Run: `cd web && npm run typecheck && npm run build`
Then `npm run dev` and open `https://dev.ecoworks.ca:3030/canvass/<a real turf id>/drive`. On a desktop there is no heading, so it must show the nearest-first fallback and the "Pointing unknown" hint rather than an empty screen.

- [ ] **Step 6: Commit**

```bash
git add web/src/canvass/DriveCard.tsx web/src/canvass/drive.css web/src/pages/DrivePage.tsx web/src/App.tsx
git commit -m "feat(drive): the glanceable card and its route"
```

---

### Task 5: Staying awake, and speaking

**Files:**
- Create: `web/src/canvass/useWakeLock.ts`, `web/src/canvass/driveSpeech.ts`
- Modify: `web/src/pages/DrivePage.tsx`

**Interfaces:**
- Produces: `useWakeLock(active: boolean): void`; `announce(text: string): void`; `readDrivePrefs()` / `writeDrivePrefs(p)` for `{ speak: boolean; names: boolean }`.

- [ ] **Step 1: Wake lock**

This project's TypeScript already knows the Wake Lock types (`lib` includes `DOM`), so call
`navigator.wakeLock` directly — no local declarations and no cast.

Create `web/src/canvass/useWakeLock.ts`:

```ts
/**
 * Hold the screen on. A display that sleeps every thirty seconds makes a glanceable screen
 * pointless, and the driver must not have to touch the phone to wake it — that is the offence the
 * whole design avoids. Re-acquired on visibilitychange because the lock is dropped whenever the tab
 * is hidden, including a passing phone call. Unsupported on some iOS versions: feature-detected and
 * degraded silently, because a missing wake lock is a worse screen, not a broken one.
 */
import { useEffect } from 'react';

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let dropped = false;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        // Denied (battery saver, no user gesture). Nothing to do but carry on.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !dropped) void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      dropped = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, [active]);
}
```

- [ ] **Step 2: Speech and preferences**

Create `web/src/canvass/driveSpeech.ts`:

```ts
/**
 * The hands-free half of drive mode. Speaking the next door is the entire reason a solo driver can
 * use this without touching anything, so it is on by default; the toggle exists for when a passenger
 * is reading aloud instead. Preferences are UI state, so localStorage in try/catch, matching
 * readDoorOrder in nearMe.ts.
 */
const KEY = 'mc-canvass.drive-prefs';

export interface DrivePrefs {
  speak: boolean;
  names: boolean;
}

export function readDrivePrefs(): DrivePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { speak: true, names: true };
    const p = JSON.parse(raw) as Partial<DrivePrefs>;
    return { speak: p.speak !== false, names: p.names !== false };
  } catch {
    return { speak: true, names: true };
  }
}

export function writeDrivePrefs(p: DrivePrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private mode refuses to store; the toggles still work for this session.
  }
}

/** Speak once. Cancels anything still queued so a stale door is never announced after a new one. */
export function announce(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    // Some browsers throw without a prior user gesture; silence is an acceptable failure here.
  }
}
```

- [ ] **Step 3: Wire both into the page**

In `DrivePage.tsx`: call `useWakeLock(true)`. **Replace** the plain `useState(true)` for `showNames`
that Task 4 introduced with state seeded from `readDrivePrefs()`, persisting through
`writeDrivePrefs` on every change, so the shape is `const [prefs, setPrefs] = useState(readDrivePrefs)`
and the card receives `prefs.names`. Then announce when the selected door *changes*:

```tsx
const spokenFor = useRef<string | null>(null);
useEffect(() => {
  const c = selection?.current;
  if (!c || !prefs.speak) return;
  if (spokenFor.current === c.door.household_id) return;
  spokenFor.current = c.door.household_id;
  const side = c.side && !selection?.fallback ? `, on your ${c.side}` : '';
  announce(`Next door, ${Math.round(c.distance_m / 10) * 10} metres${side}`);
}, [selection, prefs.speak]);
```

Note the announcement carries **no name**, regardless of the names toggle: a spoken name carries further than a screen does, and nothing is gained by it while driving.

- [ ] **Step 4: Verify**

Run: `cd web && npm run typecheck && npm test && npm run build`
Then in the browser: the screen must not dim, and toggling speech must survive a reload.

- [ ] **Step 5: Commit**

```bash
git add web/src/canvass/useWakeLock.ts web/src/canvass/driveSpeech.ts web/src/pages/DrivePage.tsx
git commit -m "feat(drive): keep the screen awake and announce the next door"
```

---

### Task 6: Way in, safety notice, and the docs

**Files:**
- Modify: `web/src/pages/DoorScreen.tsx`, `web/src/pages/DrivePage.tsx`, `web/src/components/changelog-modal.tsx`, `CHANGELOG.md`, `docs/README.md`

- [ ] **Step 1: Entry point**

In `DoorScreen.tsx`, immediately after the "Near me" order toggle — the
`<button className="cv-seg__btn cv-viewbtn" aria-pressed={order === 'near'}>` around line 225 — add a
react-router `<Link>` to `/canvass/${turfId}/drive` labelled **Drive**, carrying the same two classes.
`Link` is already imported. `turfId` comes from `useParams` and may be undefined, so render the link
only when it is set. Unlike the Near-me toggle it is **not** gated on `view === 'list'`: drive mode is
a way of leaving this screen, not a way of ordering its list. It is a link, so it takes no
`aria-pressed`. Check that `.cv-seg__btn` renders correctly on an `<a>` (no underline, inherited
colour); if it needs a reset, grep first and extend the existing rule in `canvass.css` rather than
declaring the selector a second time.

- [ ] **Step 2: The one-time interstitial**

In `DrivePage.tsx`, before the card renders for the first time ever on this device (`localStorage` key `mc-canvass.drive-seen`, in try/catch), show a full-screen notice with a single **Start** button:

> Mount your phone before you drive. This screen updates itself — you should never need to touch it while the car is moving, and in Ontario handling a phone while driving is an offence. Drive on a charger: continuous GPS with the screen on is heavy on the battery.

- [ ] **Step 3: In-app changelog**

In `web/src/components/changelog-modal.tsx`: bump `APP_VERSION` to `'1.1.0'` and add a `CHANGELOG` entry at the top of the array, written for campaign staff:

```ts
{
  version: '1.1.0',
  date: '2026-09-18',
  changes: [
    'New drive mode: on a rural turf it shows the next door ahead of you, how far it is and which side of the road, and moves on by itself as you pass. Open a turf and tap Drive.',
    'It can read the next door out loud, so you never need to touch the phone while the car is moving.',
  ],
},
```

- [ ] **Step 4: `CHANGELOG.md` and `docs/README.md`**

Add a matching `## [1.1.0] - 2026-09-18` section with an `Added` entry. In `docs/README.md`, add `drive.ts` / `DrivePage.tsx` to the file tree and one paragraph under the canvass section explaining the along/cross-track choice and the hysteresis rule — that is the part a future reader will otherwise "simplify" and break.

- [ ] **Step 5: Full verification**

```bash
cd web && npm test && npm run typecheck && npm run build
```

Then the field test, which is the only one that really counts: drive a concession road with a known turf and confirm the card advances at the right moment, names the correct side of the road, and does not flicker between two doors.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/DoorScreen.tsx web/src/pages/DrivePage.tsx web/src/components/changelog-modal.tsx CHANGELOG.md docs/README.md
git commit -m "feat(drive): entry point, safety notice and docs"
```
