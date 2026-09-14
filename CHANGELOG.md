# Changelog

All notable changes to MC Canvass are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.2] - 2026-09-14

### Fixed

- **Subscriber link hardening**, from an adversarial review of the phase-8
  feature. The matcher now auto-links only *confirmed* website subscribers
  (a pending or direct-form row, whose email ownership is unproven, can only
  be suggested — closing a double-opt-in bypass); the "exactly one voter"
  test counts every exact match, not just undecided ones; withdrawn
  door-contact values can suggest but never auto-link; a voter matching on
  both email and phone is counted once; and already-handled requests are no
  longer matched.
- **Rejecting a match now works as an undo.** Rejecting the candidate a
  request is linked to clears the link and re-opens it for matching, and the
  queue shows an "Undo — not them" control on an accepted match. Accepting
  one candidate demotes any rival accepted match so a re-import can't
  resurrect a superseded link.
- **Every machine read/link is audited** — the exact-suggestion and
  ledger-replay paths now write audit rows like the rest; a decision records
  the candidate id (never the name/address).
- One malformed export row can no longer wedge a whole sync pass; the sync
  URL must be https (it carries a bearer token); and `import.py --force` now
  warns that the sign-up queue and match suggestions will be cleared.

## [0.6.1] - 2026-09-14

### Fixed

- **The base-layer menu opened invisibly on a phone.** The map toolbar scrolls
  sideways on a narrow screen, and a sideways-scrolling box also clips anything
  hanging below it — so the layer dropdown was cut off the instant it opened and
  the button looked broken. The menu now floats above the map instead of inside
  the toolbar.
- **The map's data-source credit no longer covers the bottom of the map on
  load.** It starts as the small ⓘ button and opens on a tap, instead of
  mounting as an expanded shaded panel.

## [0.6.0] - 2026-09-14

### Added

- **The website subscriber link (phase 8).** Sign-ups from sean-hunt.com now flow into the
  Sign-ups queue on their own: a sync worker pulls the website's admin export every five minutes
  (pull, not push — no new public endpoints, no credentials on the website, downtime self-heals),
  and a local matcher ranks likely voter matches per sign-up — exact email/phone joins against
  door-collected contact info, then nickname-aware fuzzy name and address matching, all in
  Postgres, with no voter row ever leaving this stack. Exact single-voter contact hits may
  auto-link (`MATCH_AUTO_ACCEPT=exact`, settable to `off`); everything fuzzier is a suggestion an
  organizer confirms with one click on the new **Sign-ups** screen. Decisions live in a ledger
  that survives voters-list re-imports, every machine action is audited, and a match remains a
  pointer — it never merges website data into the voters list and never mints messaging consent.

## [0.5.3] - 2026-09-11

### Changed

- **Loading states now look like what is coming.** A spinner says something is happening; a
  skeleton shaped like the page says a list of eight tiles, or a five-column table, is on its way —
  which is what stops someone on a weak rural connection reloading a fetch that was already
  working. Applied across stats, reports, turfs, canvass, signs, messaging, users, audit and
  account, and to the route-level fallbacks so the placeholder matches the page that replaces it.

  Deliberately not applied to anything where nothing is arriving: Save buttons, GPS fixes, photo
  uploads and the map screens all keep their spinner, because bars would promise rows that never
  come. One skeleton was *removed* for that reason — the signs map was showing a stack of list bars
  before rendering a map.

  The shapes share one accessibility contract: a labelled region is `role="status"` with
  `aria-busy` and a visually-hidden label, the bars themselves are decorative, and a second shape on
  an already-announcing screen stays silent rather than announcing twice.

## [0.5.2] - 2026-09-11

### Added

- **A public endpoint for the campaign website's sign-up form** (`POST /api/public/requests`), so a
  lawn-sign request typed on sean-hunt.pages.dev reaches the campaign's own system instead of an
  inbox. Organisers read them at `GET /api/public/requests` and mark them handled, recording the
  door the address turned out to be.

  It is the second unauthenticated write endpoint on a stack that holds the voters list, so it is
  built to the same rules as the SMS opt-in route: an identical response for every outcome (a form
  that answers differently is an oracle over the campaign's list), its own table that is never
  merged into `voter` or `household`, a 10/hour per-IP limit, a honeypot instead of a CAPTCHA, and
  an explicit origin allowlist rather than `*`. It sends nothing — a reply would be a message to an
  address nobody has confirmed.

  `db/migrations/006_public_requests.sql` adds `public_request`. The address is free text on
  purpose: a public form has no household id, and resolving one to a door is a human job.

## [0.5.1] - 2026-09-11

### Fixed

- **The map was showing "Access blocked — App is not following the tile usage policy" instead of
  streets.** Those were not map tiles: OpenStreetMap serves that image as a 403 when it blocks an
  app. The default "Streets" basemap pointed at `tile.openstreetmap.org`, whose servers are
  volunteer-run and donated and whose usage policy does not permit an application using them as its
  basemap — which is exactly what a pannable map of 7,000 doors was doing.

  "Streets" is now Esri's World Street Map: no key, and the same endpoint already serving the
  satellite layer. Nothing in the app requests an OSM tile any more. OSM *data* attribution stays
  where CARTO is used, because that is a separate obligation and still owed.

## [0.5.0] - 2026-09-11

### Added

- **Record a visit from the map.** Tapping a door and recording what happened no longer requires
  finding the turf first — the card has the same one-thumb result buttons as the door screen. It
  works for a door in **no turf at all**, which `contact.turf_id` has always allowed and nothing
  could do.

- **A lawn sign asked for at the door becomes a real request.** Ticking "wants a lawn sign" reveals
  an address field prefilled with the door's own address, and the contact now writes a row into
  `sign` with status `requested` rather than leaving a boolean for somebody to go looking for. The
  address matters: a corner lot wants the sign on the side street, a farm wants it at the gate
  rather than the house 400 m up the lane, and the delivery crew was rediscovering that at every
  stop. Idempotent on a derived key, so a replayed submission cannot raise a second request.

  `db/migrations/005_sign_request_address.sql` adds `contact.sign_address`, nullable — contacts
  already recorded keep their boolean and say honestly that no address was captured, rather than
  being backfilled with a confirmation nobody gave.

### Fixed

- The delivery list dropped a door the moment its request was recorded, because it excluded any
  household with a sign row. It now excludes only signs that are *not* still `requested`.

## [0.4.6] - 2026-09-10

### Added

- **Actions on a door you tap on the map.** The card told you who lived there and then offered
  nothing, so recording a visit meant remembering the address, finding the turf and walking in from
  the door screen. It now leads with **Open in the door screen** (when the door is in a turf you can
  walk), **Place a lawn sign**, and **Directions** in the phone's own map app.

  The actions are there whether or not the door is in a turf — a door outside every turf is the one
  *most* likely to need a sign or directions, not the least — and when there is no turf the card
  says so plainly rather than hiding the button with no explanation.

  `GET /api/households/:id` now returns `turfs: [{ id, name }]` to make this possible, scoped the
  same way as everything else: a volunteer is told only about turfs assigned to them, so it cannot
  become a way to enumerate the campaign's turf structure.

## [0.4.5] - 2026-09-10

### Fixed

- **The print button did nothing on an installed iPhone.** iOS silently ignores `window.print()` in
  a web app added to the home screen — no dialog, no error — so the button looked broken. On an
  iPhone it now says "Open in Safari to print" and does that, where Share → Print works. Android's
  standalone mode prints fine and is unchanged.

### Added

- **The paper sheet is reachable from the turf drawer**, so a volunteer can get to it. It was only
  linked from the organiser-only Turfs page.
- **Tap a turf boundary on the map to open that turf.** The map was a dead end: the only way to
  turfs was the nav menu. The overlay toggle is now labelled "Boundaries" so "Turfs" means one
  thing again.
- **List-shaped loading skeletons** on the door screen and the turf sheet, replacing a bare
  spinner. A spinner says something is happening; a skeleton says a list is coming and roughly how
  long — which is what stops someone on a weak rural connection reloading a 1,330-door fetch.

### Changed

- `web/tools/e2e.py` takes `E2E_BASE` / `E2E_EMAIL` / `E2E_PASSWORD`. The admin password was
  hard-coded and went stale the day it was changed, which quietly made the whole suite unrunnable.

## [0.4.4] - 2026-09-08

### Changed

- **More map on a phone.** The search field took a whole row and pushed the toolbar onto a second
  one, which together ate roughly a third of the screen the page exists to show. Search is now an
  icon that expands over the toolbar, the toolbar never wraps (it scrolls if it must), and the
  controls are translucent so the map reads through them.
- **The door card leads with the people.** Voter names come first; the counts, the address-match
  chip and "Centre on map" moved into a "This record" section below them — reference material a
  canvasser scrolls to rather than what they opened the card for.

### Fixed

- **"Centre on map" put the door underneath the sheet that asked for it.** The map was centring on
  the whole canvas while the door sheet covered the bottom ~60% of a phone screen. It now measures
  the sheet at call time and centres within the map you can actually see — the bottom edge on a
  phone, the right edge on a desktop, since it is the same element at a different edge.

## [0.4.3] - 2026-09-08

### Added

- **Turf boundaries on the main map**, behind a "Turfs" toggle that is remembered and off by
  default. A volunteer sees the turfs assigned to them; an organiser or admin sees every active
  turf with their own drawn heavier and solid, everyone else's lighter and dashed — the same hue at
  two weights rather than two colours, so the overlay never competes with the colour mode painting
  the doors underneath, and the two stay distinguishable printed in mono. Names label each shape
  from z11. Scoped server-side by `GET /api/turfs/shapes`, which carries a name, a shape and two
  counts and no door data at all.

  A turf built by picking streets has no boundary of its own, so one is approximated from its doors
  — a padded convex hull — and drawn dotted. That distinction is not cosmetic: a hull spans the gaps
  between its streets and can cover doors that are not in the turf, so it says roughly where the
  turf is and never which doors are in it. The map says so in words as well as in the dash.

## [0.4.2] - 2026-09-08

### Added

- **An "Unreachable" report** (`/reports?tab=unreachable`, organiser and above) explaining why part
  of the list cannot be reached, and what to do about each reason. Grouped by what is knowable off
  the list before anyone leaves the house — no civic address, a non-resident owner, an institution —
  versus what a canvasser learned at a door.

  Every category says **which channel** it rules out, because "unreachable" is not one thing: a
  PO-box mailing address (306 doors here) blocks lettermail and nothing else, and the door is
  perfectly knockable. Folding that into one number would have reported 390 unknockable doors where
  there are 73 — a planning error, not a cosmetic one, so there is a regression test pinning it.
  Counts are also de-duplicated, and `no_map_point` is shown as the parent of its two causes rather
  than a peer that adds to them.

  The endpoint returns **aggregates only** — no name, address or id, asserted in the suite.

- **AI advice on that report**, written by Claude from those aggregate counts (`ADVICE_API_KEY`,
  Anthropic, `claude-sonnet-5` by default). Off unless a key is set, and the report's own written
  guidance renders without it. Only category codes and integers are sent: `AdviceInput` has no
  field that can carry a row, a runtime guard re-checks the payload before it leaves, and the test
  suite asserts the outgoing body against real elector names and addresses from the database. The
  answer is cached on a hash of the numbers, so opening the report repeatedly bills once, and every
  failure path returns null rather than breaking the report.

## [0.4.1] - 2026-09-06

### Added

- **A map of the lawn signs**, as a fourth tab on `/signs`. Every placed sign and every outstanding
  sign request on one canvas, because in the field they are two halves of one job: a request is a
  door that said yes and is waiting, a placed sign is one already in the ground, and seeing them
  together is what turns "17 requests" into a driving route. Requests are drawn hollow and placed
  signs filled; missing and damaged share a colour because the action is the same. Each type toggles
  on and off, and tapping a marker gives the address, status, who and when, GPS accuracy and photo
  count, with links straight to placing a sign at that door. MapLibre is lazy-loaded, so the other
  three tabs do not pay for it.

### Fixed

- **The turf highlight was unreadable on any real turf.** The per-door ring was sized against the
  demo stack's 18 doors; the Ilderton turf is 1,330 over ~1540x1806 m, which puts neighbouring doors
  ~9.6 px apart at village zoom — closer together than the ring was wide. Every ring merged into one
  black shape and the map underneath was gone. The turf's own drawn boundary now carries it at
  overview zoom (one shape, whose cost does not grow with the door count) and the per-door rings
  fade in from z15.2, where the same doors are ~25 px apart.

## [0.4.0] - 2026-09-06

Phase 3 complete: the app works with no signal, on paper, and on a tablet.

### Added

**Field hardening beyond the offline queue**

- **Sign photos survive going offline too.** A photo taken with no signal is downscaled and held in
  IndexedDB against the sign's `client_id`, then uploaded once the outbox learns the real sign id.
  It is a separate queue from the door outbox on purpose: the outbox count is what a volunteer reads
  as "how many doors are still on my phone", and image blobs sharing that budget would silently
  change what that number means.
- **Nearest-first door ordering** from the device GPS, with walking order still the default.
- **A printable paper turf sheet** at `/turfs/:turfId/sheet` — every door in walking order with tick
  boxes, a support scale and note lines, A4 or Letter without scaling. The Municipal Elections Act
  handling rule prints in the repeating table header, so it is on every page, with a
  chain-of-custody line for who entered the results.
- **Add to home screen**, with the manual Share instructions on iOS where `beforeinstallprompt`
  never fires.
- **A real tablet layout.** Four documented breakpoints replace six ad-hoc ones; every stop at or
  above 640px used to mean "desktop", so an iPad mini got desktop density with a finger. The door
  screen becomes master-detail at tablet width — list and open door side by side — and the
  semantics change with it: a bottom sheet is a modal dialog, a side pane is a labelled region, not
  a permanently-open modal.
- **Move or remove a turf assignee.** The API supported it from Phase 2 but nothing called it, so a
  turf could only ever accumulate people. A move is assign-then-unassign, and a half-completed move
  says so rather than claiming success.
- **Street-level imagery of a door** — optional, off unless a key is configured. Only coordinates
  leave the server, the key never reaches the browser, and the imagery is never stored, which
  Google's terms require anyway.
- **A demo stack** (`make demo`): a second database of entirely fabricated residents on real public
  street names, so screenshots, video and training never contain an elector.

### Fixed

- The door sheet was slicing the sticky turf header in half and clipping long turf names mid-word.
- A sign queued offline said "Sign recorded" when it had only been saved to the phone.
- `make import-force` counted only `contact` rows before refusing, but `TRUNCATE household CASCADE`
  empties every referencing table — it would have silently destroyed lawn signs, sign photos and
  doorstep consent records. It now names everything it would delete.
- The sync pill carried the same visual weight as the address beside it; "synced" is the state that
  needs no attention.
- The Municipal Elections Act citation was wrong throughout (s. 23(7)-(8), not s. 23 and s. 88), the
  "no merging" rule was presented as law when it is this campaign's own policy, and the s. 23(8)
  duty to collect written acknowledgements of destruction was missing entirely.

## [Unreleased]

### Added

- **A turf is a place, not a row of numbers.** Every turf card gets *Show on map*, and `/map?turf=<id>`
  fits the map to that turf and rings its doors.
- **Live shape preview when cutting a turf.** As streets are picked, the doors are drawn — so an
  organiser can see whether the selection is one contiguous walk or three islands 11 km apart, which
  the counts cannot tell them. Backed by `POST /api/turfs/preview`, which reuses the create path's
  own matching (`selectHouseholds`) rather than a second query that could drift: a preview that can
  disagree with the save is worse than no preview.
- The preview reports `unmapped` — selected households with no coordinates — so the number of dots
  never silently disagrees with the door count.


### Added

**Offline canvassing** (Phase 3)

- **A write queue behind the door screen.** `useRecordContact()` and `usePlaceSign()` now try the
  request and, when the network is the reason it failed, put the exact body into a durable outbox
  (IndexedDB, `src/offline/`) and resolve anyway — the volunteer auto-advances to the next door
  instead of watching a spinner in a driveway. Rural Middlesex Centre drops signal for whole
  concession roads; before this, a recorded result was simply lost when the POST failed.
- **The idempotency contract this rests on.** `client_id` is generated **once**, when the write is
  first attempted, and is stored with the body; every replay sends that same key. `POST /api/contacts`
  and `POST /api/signs` are idempotent on it (API.md, "Idempotency"), so a replay collapses onto the
  row already written. Queue entries are keyed and reconciled by the id the client generated — never
  by the value the server echoes back, which for a multi-voter contact is the derived
  `<client_id>:<voter_id>` and is therefore *not* the key that was sent.
- **Retry policy that stops.** The queue flushes on `online`, on app focus/visibility, on a capped
  exponential backoff (5 s → 5 min), and on an explicit "Sync now". A network failure or a 5xx keeps
  retrying; a 401 keeps retrying because signing back in fixes it; any other 4xx will never succeed,
  so it is **parked** as "needs attention" with the server's own message rather than retried forever
  or dropped. A parked write can be retried by hand or discarded, but only deliberately: a dropped
  canvass result is a door somebody knocked for nothing.
- **Offline turf cache.** Opening `/canvass/:turfId` stores that turf's doors response on the phone,
  so the door list, the names and the walking order survive with no connection and results still go
  into the queue. **Caveat, deliberately narrow:** this is voters-list data on a volunteer's phone,
  so nothing is cached until a turf is actually opened, only turfs the API served to that user are
  stored, and the sync panel has a visible "Clear saved turf data" button — `make purge` shreds the
  server after election day but it cannot reach a phone.
- **A sync status the volunteer can trust**: a pill on the turf header and inside the door sheet
  showing online/offline, how many writes are queued, when it last synced and anything parked; one
  tap opens the queue, the failures and the clear-this-phone control. It also says so plainly when
  the browser refuses IndexedDB (private mode), where the queue only lives as long as the tab.
- **"Near me" door ordering.** An optional toggle orders the door list by distance from the device
  (haversine, shared with the walking hints) instead of `walk_order`, with unmapped doors kept in
  walking order at the end. Walking order stays the default, the choice is remembered, the list only
  re-sorts once the phone has moved 10 m, and every geolocation failure falls back to walking order
  with a message the volunteer can act on.

## [0.3.0] - 2026-09-05

Lawn signs, and the rest of Phase 2.

### Added

**Lawn signs** (new — not in the original plan)

- Place a sign from a phone with the device's GPS. The reported **accuracy** is shown as prominently
  as the coordinate and can be re-taken before saving: a 60 m fix on a back concession is the
  difference between finding a sign in November and driving past it three times.
- Coordinates outside Middlesex Centre are refused. A fix that lands in Ottawa or on Null Island
  sends the retrieval crew to the wrong concession while the real sign stays up.
- Optional photo per sign, downscaled in the browser before upload. The API sniffs magic bytes
  rather than trusting the declared type, stores under a generated name, and serves only to an
  authenticated session — a photo of a sign is a photo of someone's house.
- Pickup list: every sign still standing, with coordinate, accuracy, photo and a link that opens the
  phone's map app, plus a "Picked up" action.
- Delivery list of doors that asked for a sign at the door and have not had one. This is the loop
  back from `contact.wants_sign`, which existed since Phase 1 and led nowhere. It is the one sign
  endpoint carrying voter data, so it is turf-scoped for volunteers and audited.
- Signs are their own object, not a household flag: many go on road allowances and corners that are
  not doors on the voters list. Those have no ward and sort last rather than disappearing.

**Finishing Phase 2**

- Draw a turf as a polygon on the map, with the door and voter count updating live as you tap out
  the shape. The preview uses the same ray cast as the server, so it cannot promise a different turf
  from the one that gets saved.
- Follow-up queue and volunteer activity screens at `/reports`.
- The turf builder flags streets already covered by another turf, naming the turf, so two organisers
  cannot silently cut overlapping walks and knock the same doors twice.
- `/map?household=<id>` opens straight onto a door, so the follow-up queue and delivery list can
  link to one.

**Infrastructure**

- `db/migrations/` and `make migrate`. `db/schema.sql` only ever runs against an empty database, so
  with real data loaded there had been no way to change the schema at all.

### Fixed

- `useFollowUps` unwrapped the wrong key, so the follow-up queue would have rendered permanently
  empty with no error.
- `GET /api/turfs` ignored its `archived` parameter, so archived turfs kept claiming their streets.
- `make restart-tunnel` silently dropped the database's loopback port, taking the local API offline.

## [0.2.0] - 2026-09-05

Phase 2: canvassing core — turfs, assignments and the door screen.

### Added

**Turfs and assignments**

- Turfs cut from a list of streets or from a drawn polygon, with member households materialised on
  save and given a `walk_order` along the street so doors arrive in the order you pass them.
  Point-in-polygon runs in the API rather than PostGIS, so no migration was needed.
- `ward` on a turf is a label only: it does not clip the street or polygon match, because a turf that
  stops at an invisible ward line halfway down a rural road is worse to walk than one that takes the
  whole road.
- Turf list for organisers with progress, assignees and archive, and a street picker that totals the
  doors and voters a turf would contain *before* it is saved.
- Assignments of a turf to a user, with open / in progress / done.
- `GET /api/users` lowered from admin to organizer so organisers can assign; organizers receive only
  `{ id, name, role, active }` — no email, via the same `serialize.ts` enforcement point.

**Door screen**

- `/canvass` lists a volunteer's own turfs; `/canvass/:turfId` lists that turf's doors in walking
  order and opens a phone-first door card.
- One-thumb result buttons for all eight `contact_result` values; seven record in a single tap, and
  `spoke` reveals support 1-5, the sign / volunteer / ride / follow-up flags and a note.
- After a result is recorded the screen advances to the next unknocked door.
- Every submission carries a `client_id` idempotency key, so a retry after a dropped connection
  cannot double-count a door. This is the seam the Phase 3 offline queue will use.
- Volunteers may see voter **names** at a door they are assigned — they need them to knock — but
  never mailing addresses or resident status, and only for households inside their own turfs.

**Map**

- "Canvass status" colour mode: doors coloured by their latest result, grey for not yet knocked.
- Clusters are coloured by their dominant ward instead of a flat blue.

### Changed

- Default base layer is now OpenStreetMap. CARTO's CDN began stamping "API KEY REQUIRED" across
  every tile for anonymous use; OSM and the Esri satellite layers need no key.
- `GET /api/households/:id` now serves a volunteer for doors inside their assigned turfs instead of
  always returning 403.

### Fixed

- Date-only values (an assignment's due date) rendered a day early: `new Date('2026-10-26')` parses
  as UTC midnight, which is the previous evening in Ontario.
- The API test suite no longer truncates `app_user` / `session` / `audit_log`. It refuses to run
  unless `CANVASS_TEST_DESTRUCTIVE=1` is set and the target database is not named `canvass`, and it
  deletes only the rows it created. It had wiped the admin account and audit log of a running system.

## [0.1.0] - 2026-09-05

Phase 1: self-hosted canvass stack — importer, API, MapLibre viewer.

### Added

**Stack and deployment**

- `docker compose` stack: PostgreSQL 16, Fastify + TypeScript API, Vite/React SPA (build-only stage),
  and Caddy for TLS, static hosting and the `/api/*` reverse proxy.
- `Makefile` targets for the whole lifecycle: `up`, `down`, `restart`, `logs`, `ps`, `import`,
  `import-force`, `backup`, `restore`, `purge`, `psql`, `test`.
- `db/schema.sql`, applied on the first boot of the database container: `app_user`, `session`,
  `import_run`, `household`, `voter`, `turf`, `turf_household`, `assignment`, `contact`, `audit_log`,
  plus the `household_status` / `voter_status` views. Trigram indexes on voter names and household
  addresses for search.
- README covering deployment on an Ubuntu Docker host, first login, inviting users, backups,
  re-importing and the post-election purge.

**Importer**

- Python one-shot importer (`importer/import.py`) that loads `voters_final.csv` and `households.csv`
  in a single transaction, deriving civic fields, street sort keys, legal-description and institution
  flags, and non-resident/PO-box counts.
- Idempotent by source-file sha256 recorded in `import_run`; identical files are a no-op, and a
  re-import is refused (exit 2) when canvass contacts exist unless forced.
- Prints per-ward and per-community counts, `hh_flag` values seen, and legal/institution totals.

**Authentication and roles**

- Session-cookie auth (`canvass_sid`, HttpOnly, Secure, SameSite=Lax) with argon2 password hashing;
  every page and every API route but login, accept-invite and health requires a session.
- Roles `admin` > `organizer` > `volunteer`, enforced server-side on each route and reflected in the UI.
- First-boot bootstrap of the admin account from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, ignored once any
  user exists.
- Single-use invite links valid for 7 days (`/invite/<token>`), with re-invite doubling as a password
  reset. No email service: the admin sends the link. The last active admin cannot be demoted or
  deactivated.
- Change password (minimum 10 characters), which ends every other session. Login is rate-limited
  per IP.

**Role-gated data access**

- Volunteers receive anonymous household points only — no names, mailing addresses, resident status,
  record quality or municipality-wide search. Household cards return 403 for volunteers in Phase 1.
- Organizers and admins get household cards with voters, mailing details and record quality, search,
  streets and stats. Admins additionally get user management and the audit log.

**Map**

- MapLibre GL viewer over the whole municipality with clustered household points, the Middlesex Centre
  boundary, and three base layers (CARTO light, OpenStreetMap, Esri imagery). Map fonts are served
  from our own origin.
- Colour modes: ward, community, voters per door, and — for organizers — record quality and
  non-resident owners, each with a matching legend.
- Filters drawer for ward, community and record quality, with per-filter door and voter counts.
- Household card as a side sheet on desktop and a bottom sheet on phones: voters, resident status,
  mailing addresses that differ from the property, institution flag and "centre on map".
- "Unmapped parcels" list for the 70 households recorded by legal description (concession/lot) with
  no civic address, so they stay reachable.
- Chosen base layer and colour mode persist in `localStorage`; MapLibre is code-split and loaded only
  when the map is opened.

**Search, streets and stats**

- Search across voter names and household addresses (trigram similarity, plus "123 King" number +
  street matching), audited on every query.
- `GET /api/streets` — street roll-up by ward and community with household/voter counts and civic
  number ranges, the base for the Phase 2 turf builder.
- Stats dashboard: totals, breakdowns by ward and community, voters per door, record quality, and a
  placeholder canvass section that fills in once door-knocking starts.

**Compliance**

- `audit_log` records logins and failed logins, logouts, household views, searches, invites,
  accept-invite, user changes, password changes and exports; admins browse and filter it in the app.
- Municipal Elections Act notices in the footer, on the account page and on the audit page:
  election use only, access is logged, the list is destroyed after the election.
- `make backup` writes `pg_dump | gzip | gpg --symmetric --cipher-algo AES256` archives;
  `make purge` stops the stack, deletes every volume and shreds the source CSVs.

**Progressive web app**

- Installable on phones (web manifest and icons) with a build-generated app-shell service worker that
  caches the hashed bundle files — no workbox dependency. API responses are not cached; offline turf
  data arrives in Phase 3.

[0.1.0]: https://github.com/smhunt/mc-canvass/releases/tag/v0.1.0
