# Drive mode — surfacing the next door ahead while driving

**Status:** built on `feat/drive-mode`; awaiting a field test. **Date:** 2026-09-18.

## The problem

Middlesex Centre is rural. Outside the settlements a "door" is a driveway several hundred metres
from the last one, and canvassing is really *driving* between doors. The two orderings that exist
today both assume a person on foot:

- **Walk order** is the order the street is built for — right on a concession road, useless when the
  next door is 600 m away and you have just driven past it.
- **Near me** (`web/src/canvass/nearMe.ts`) sorts by straight-line distance from the device. It has
  no idea which way you are pointing, so the nearest door is frequently the one *behind* you.

What is missing is direction. While driving, the useful question is not "what is closest" but
**"what is the next door in front of me, and which side of the road is it on."**

## Success criteria

1. A glanceable card naming the next door **ahead**, its distance, and the side of the road.
2. It advances by itself as doors are passed. No tap is required to keep using it.
3. It is stable — the card does not flicker between two doors.
4. It works with no signal (rural dead zones are the normal case).
5. Names are visible at a glance, and can be hidden with one tap when the phone is left in a parked
   car or handed to someone outside the campaign.

## Constraint that shapes the design: the driver

The answer to "who touches the screen while moving" is **both** — solo some days, with a passenger
on others. That forces two modes in one screen rather than a choice between them:

- **Moving, solo:** zero-touch. Auto-advancing, large type, optional spoken announcement. Ontario's
  *Highway Traffic Act* s. 78.1 makes *handling* a phone while driving an offence; a mounted phone
  that is only looked at is legal. A campaign tool must not be the reason a candidate is holding a
  phone at 80 km/h, so **no control in this mode may be necessary while moving.**
- **Passenger, or stopped:** the same card expands on tap into the ordinary door detail, with names,
  history and the record-a-visit flow.

## Why this is a new screen, not a third sort order

The obvious cheap option is a `walk | near | drive` toggle on the existing list. It fails on its own
terms: `RESORT_THRESHOLD_M = 10` in `nearMe.ts` is tuned for someone standing still ("well inside one
rural lot frontage"), and at 80 km/h that threshold is crossed every **0.45 seconds**. A list sorted
that way re-orders continuously and cannot be read, let alone read safely.

Showing exactly one door cannot churn. That is the whole argument for a separate screen.

## Architecture

New route `/canvass/:turfId/drive`, `lazy()`-loaded into its own chunk like every other heavy route.

**No API change at all.** `useDoors(turfId)` already returns each door's `lat`/`lon` and status, it
already writes the turf cache and falls back to it on a network failure, and volunteers are already
scoped to their assigned turfs. Nothing new leaves the server, so there is no `serialize.ts` change,
no new `AuditAction`, and no `API.md` change.

Three new units, each testable on its own:

### 1. `web/src/canvass/drive.ts` — the maths (pure, no browser)

Along-track / cross-track projection rather than a fixed angular cone. A cone is wrong at close
range: a door 40 m ahead and 25 m off the road sits 32° off the heading, while the same door at 400 m
sits 3.6°, so any fixed angle is simultaneously too tight far away and too loose nearby.

For each door, given the device position and heading:

- `bearingDeg(from, to)` — numeric bearing. Extracted from the existing `compassOf` in
  `directions.ts`, which already computes this and then throws the number away by rounding to eight
  points. `compassOf` is refactored to call it, so there is one bearing implementation, not two.
- `delta = angleDiff(bearingDeg, heading)` — signed, wraparound-safe, in (-180, 180].
- `along = distance * cos(delta)` — positive means ahead.
- `cross = distance * sin(delta)` — magnitude is how far off the line of travel; **sign gives the
  side of the road**, which is what lets the card say "on your right".

Selection: keep doors with `along > 0` and `|cross| <= CROSS_LIMIT_M`, then take the smallest
`along`. **`CROSS_LIMIT_M = 150`**: generous enough for a deep rural lot set well back from the
road, and safe against catching the parallel road, because Ontario concession roads are surveyed
roughly 2 km apart. It is a named constant so a field test can move it.

**Hysteresis is the stability rule and must not be dropped.** Once a door is selected it stays
selected until `along` goes negative (it has been passed) or it is recorded. A held door is also let go
if it drifts more than `HELD_CROSS_LIMIT_M = 300` off the line of travel — twice the acquire limit —
because the driver has turned off its road. The two thresholds differ on purpose: acquiring at 150 m
and releasing at 300 m is what stops a bend in the road from dropping and re-picking the same door,
while a genuine turn still releases it. `AHEAD_MAX_M` does not apply to a held door. Without this, two doors
at nearly equal along-track distance swap places every GPS tick and the card strobes — the exact
failure the separate screen exists to prevent.

When `heading` is null — phones only report course while actually moving, so this is the normal case
in a driveway — the module falls back to plain nearest-first using the existing `orderByDistance`,
and the card says so rather than showing an empty screen.

### 2. `web/src/canvass/useDriveFix.ts` — the position feed

A `watchPosition` tuned for a moving vehicle, capturing `heading` and `speed` as well as position.

This deliberately does **not** reuse `useNearMe`, for the same reason `nearMe.ts` itself declined to
reuse `signs/geolocation.ts` and says so in its header: the defaults are opposite. Near-me accepts a
15-second-old position because "nobody walks 10 m in the time it takes to open the list"; at 80 km/h
a 15-second-old position is **330 m** stale and points at the wrong door. Drive mode therefore uses
`maximumAge: 0`, and the 10 m re-sort threshold does not apply at all — stability comes from the
hysteresis above, not from ignoring movement. The failure-message handling is the one part worth
sharing, and is lifted into a small shared helper rather than written a third time.

### 3. `web/src/canvass/DriveCard.tsx` + `web/src/pages/DrivePage.tsx` — the screen

The card shows, in descending type size: **distance counting down**, **civic address**, **side of
the road**, and the door's status colour from the existing `map/palette.ts`. Below it, the next two
or three doors in small type — useful to a passenger, ignorable by a driver.

**The card shows the elector name(s).** An earlier draft withheld them, on the argument that a
windshield-mounted phone is readable from outside the car. The candidate judged that over-cautious
and the name is what makes the card useful — you are about to knock on this person's door and want
to arrive knowing who answers it. Recorded here because it was a deliberate call, not an oversight:
the residual risk is a passer-by reading one name off a screen, which is materially smaller than the
printed turf sheet already carried door to door. The same mute-style toggle that controls speech also
hides names, for when the phone is handed to someone outside the campaign or left visible in a parked
car. Full detail and history stay behind the tap into the existing `DoorSheet`.

Supporting behaviour:

- **Screen Wake Lock** (`navigator.wakeLock.request('screen')`), re-acquired on `visibilitychange`
  and released on unmount. A screen that sleeps every 30 seconds makes the whole feature pointless.
- **Spoken announcement** via `speechSynthesis`, once per newly-selected door ("next door, four
  hundred metres, on your right"). This is the entire hands-free story for solo driving, so it is on
  by default, with a large mute control for when a passenger is reading aloud instead. The preference
  persists in `localStorage` in a try/catch, matching `readDoorOrder`.
- **A one-time interstitial** on first entry: mount the phone, do not tap while moving.
- Layout uses the existing four breakpoints only. The landscape-phone stop
  (`(orientation: landscape) and (max-height: 500px)`) matters more here than anywhere else in the
  app, because a car mount is usually landscape. **No fifth number.**

## Error handling

| Condition | Behaviour |
|---|---|
| Permission denied / insecure origin | The existing `NearFailure` copy, which is already written for someone outdoors |
| `heading` null (stopped, or a phone that will not report course) | Fall back to nearest-first, and say "pointing unknown — nearest first" |
| No door ahead within range | "No more doors ahead in this turf" rather than a blank card |
| Offline | Unaffected: the door list comes from the turf cache and GPS needs no network |
| Wake Lock unsupported (iOS Safari historically) | Feature-detect, degrade silently, mention it in the interstitial |
| Doors with no `lat`/`lon` | Excluded from selection — a bearing to an ungeocoded door is meaningless. They stay reachable in the normal list, exactly as `orderByDistance` already keeps them |

## Testing

`web/src/canvass/drive.test.ts` — pure, no database and no browser, in the shape of `api/test/geo.test.ts`:

- `bearingDeg` against known cardinal pairs, and that `compassOf` still returns what it did before
  the refactor (a regression guard on the extraction).
- `angleDiff` across the 0°/360° wrap, which is where this class of bug always lives.
- Along/cross-track signs: a door ahead-right, ahead-left, behind, and abeam.
- Selection picks the smallest positive `along` and ignores a nearer door that is behind.
- **Hysteresis:** a fixed sequence of positions must not swap selection between two near-equidistant
  doors; the selection changes only after the first is passed.
- `heading: null` falls back to nearest-first.

Field test is the real one and cannot be skipped: drive a concession road with a known turf and
confirm the card advances at the right moment and names the correct side of the road.

## Deliberately not in scope

- Turn-by-turn routing or an optimised route around the turf. The existing "open in Maps" link
  (`mapsUrl`) already hands navigation to the phone's own map app, which does it better.
- Any map rendering in this screen — MapLibre re-rendering every GPS tick is the battery-hungriest
  option and a moving map is more distracting than a static card.
- Recording a visit while moving. Recording happens stopped, through the existing flow.

## Known cost

Continuous high-accuracy GPS plus a wake lock is the heaviest thing this app does to a battery. The
honest guidance, which belongs in the interstitial, is to drive with the phone on a charger.

## Amendments made during the build

The text above is the design as approved. These are the places the build knowingly departs from it;
each was a recorded ruling, with its reasoning, in the execution ledger.

- **Tapping the card does not yet open the door detail — deferred.** It needs a `?door=` deep link
  into `DoorScreen`'s open-door state, which means changing the live door screen five weeks before
  the election. Today's path is "Back to the list", where with Near me on the door is the top row.
  Workable, because recording happens stopped; it is the first follow-up.
- **Two toggles, not one.** "Speech: on/off" and "Names: on/off" are separate controls with state
  labels and `aria-pressed`; a verb label plus `aria-pressed` reads backwards to a screen reader.
- **Wake Lock degradation is silent**, and the notice does not mention it — the notice is kept short
  enough to actually be read.
- **The offline gap is closed by memory, not timing.** `outbox` drops an entry from the queue before
  its listeners refresh the door list, so for a few round-trips a just-recorded door looked open
  again. The page remembers every household it has seen queued during this visit and never offers it.
- **No heading: hold, and stay quiet.** With no course from the phone the screen still falls back to
  nearest-first, but it keeps the held door while that door is open, and announces nothing — phones
  flip between no heading and a noisy one at a stop sign, and a parked car needs no voice. A negative
  heading is treated as none.
- **Spoken confirmations.** Tapping Start, and turning speech on, each say a short phrase from inside
  the tap: an audible check before driving off, and the user gesture iOS wants before it will allow
  speech that is not triggered by one.
- **GPS and the wake lock start only after the notice is dismissed**, so the location prompt does
  not land on top of the safety notice.
- **The Drive link sits with the list view's controls.** Shown in map view too, it became a second
  child of the header controls and broke the rule that lets the Map toggle fill the row.

