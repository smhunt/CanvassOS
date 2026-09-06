# Changelog

All notable changes to MC Canvass are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
