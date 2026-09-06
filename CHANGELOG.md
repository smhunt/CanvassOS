# Changelog

All notable changes to MC Canvass are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
