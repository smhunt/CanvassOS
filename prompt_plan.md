# Middlesex Centre Canvass — build plan

Self-hosted (Docker) voter map + canvassing tool for the Sean Hunt mayoral campaign.
Users: Sean (admin), a small core team (organizers), volunteers on phones at the door.

---

## Status — 2026-09-05

Everything below this section is the **original plan, unedited**: a record of what was intended, not of
what happened. This section is the difference between the two. `CHANGELOG.md` has the release-by-release
detail; `docs/README.md` describes what the code actually does now.

| Phase | State | Notes |
|---|---|---|
| 1. Foundation + read-only viewer | **shipped** | Compose stack, `db/schema.sql`, the Python importer, login/roles/invites, full-municipality map with filters and search, household card, stats dashboard. 7,140 households / 16,892 voters loaded; 7,067 mapped, 70 legal descriptions, 11 institutions. |
| 2. Canvassing core | **shipped** | Turfs from picked streets *or* a drawn polygon, `turf_household.walk_order`, assignments, the door screen with results/support/notes/flags, latest-status colouring on the map, follow-up queue, per-user activity. |
| 3. Field hardening | **shipped** (landing at the time of writing — in the working tree, not yet committed) | PWA install and the app-shell service worker shipped back in Phase 1; walking order along the street shipped with turfs. Now added: the offline turf cache and write queue (`web/src/offline/` — IndexedDB, backoff, parked entries surfaced to the volunteer), nearest-first ordering from device GPS (`web/src/canvass/nearMe.ts`, with walk order still the default), and the printable turf sheet at `/turfs/:turfId/sheet`. |
| 4. Reporting + admin | **partly** | Encrypted backup/restore and `make purge` shipped in Phase 1; the audit log and admin user management with it. **Not landed:** coverage/support reports beyond `/api/stats/overview` and `/reports`, CSV export with audit entries, and the diff-based list re-import (today `make import-force` deletes canvass data instead — see CLAUDE.md). |

### Added outside the original plan

- **Lawn signs.** Not in this document at all. Place a sign from a phone with the device's GPS and its
  reported accuracy, an optional photo (magic-byte sniffed, stored on a volume rather than in the
  database), a pickup worklist of everything still standing, and a delivery list of doors whose latest
  contact ticked `wants_sign`. The driver is a by-law deadline, not canvassing: a sign nobody can find
  after election day is a fine. `db/migrations/001_signs.sql`.
- **Doorstep phone numbers and email addresses**, in their own `voter_contact` table with per-purpose
  consent, a recorded (never deleted) withdrawal, and an organizer-only GOTV send list. Deliberately
  separate from `voter` because it is not list data and CASL, not the Municipal Elections Act, governs
  it. `db/migrations/002_voter_contact.sql`.
- **A migration runner.** The original plan assumed `db/migrations/` existed; it did not. `db/migrate.sh`
  + `make migrate` + the `schema_migration` table now carry every change after first boot.
- **A second deployment mode.** The plan assumed a public host with Let's Encrypt. The live setup is
  `make up-tunnel`: Caddy on `127.0.0.1:3031` behind a Cloudflare Tunnel, with `X-Forwarded-For`
  rewritten from `CF-Connecting-IP` so `audit_log` records the real client.
- **A demo stack.** `demo/seed_demo.py` builds `canvass_demo` from entirely fabricated residents (web
  3032 / API 3132), so screenshots, video and training never contain a real elector.
- **The pipeline.** `pipeline/build_lists.py` reconstructs the importer's two CSVs from the clerk's list
  and county address open data. The original was lost; `resident_class` differs from the original's
  numbers and the non-resident layer should be treated as indicative.

### Decisions from "Open decisions" that were settled

Public domain with Let's Encrypt (then moved behind a Cloudflare Tunnel); email + password with invite
links; MapLibre GL; the 1–5 support scale; volunteers see voter names but no mailing addresses or
non-resident details. The four containers became five (`web` is a build-only service that copies the
built SPA into a volume and exits). PostGIS is in the image but has never been enabled — turf polygons
are point-in-polygon'd in TypeScript so the schema still runs on bare Postgres.

---

## Ground rules

- The voters list is personal information supplied under the Ontario Municipal Elections Act. It may only be used for election purposes, must be kept secure, and should be destroyed after the election. Everything below assumes: TLS only, login required for every page, role-based visibility, audit log, encrypted backups, a `make purge` target for after Oct 26.
- Stack follows Sean's conventions: React + TypeScript front end, PostgreSQL (with PostGIS) back end, Node/TypeScript API, everything in docker compose. Explicit over magic; small commits.
- Phones first. Volunteers will be on rural roads with weak signal: the door screen must work with a stale connection and sync when it can.

## Architecture

```
┌──────────┐   https   ┌─────────┐   /api   ┌──────────┐        ┌────────────────────┐
│ browsers │──────────▶│  caddy  │─────────▶│  api     │───────▶│ postgres + postgis │
│ (PWA)    │           │ (TLS,   │  static  │ (node,   │        │ voters, households │
└──────────┘           │ proxy)  │─────────▶│ fastify) │        │ contacts, turfs    │
                       └─────────┘   web    └──────────┘        └────────────────────┘
                                          (react build served by caddy)
```

Four containers: `caddy`, `api`, `db`, and a one-shot `importer` that loads the pipeline CSVs.
Map tiles come from public OSM/CARTO/Esri endpoints (no tile server to run); household points are served from our API as GeoJSON per viewport / per turf.

## Data model (PostgreSQL)

- `household` — id (H-KOMOKA-00123), civic fields, community, postal, locality, ward, geom (PostGIS point), n_voters, addr_match, quality flags, institution flag.
- `voter` — id, household_id, name fields, ward, mailing fields, resident_class, mail_kind, record_quality. Original (raw) strings kept for traceability.
- `turf` — id, name, ward, polygon geom, created_by. Households belong to a turf by spatial join (materialized on turf save).
- `assignment` — turf ↔ user, status (open / in progress / done), dates.
- `contact` — the canvass event: household_id, voter_id (nullable = whole door), user_id, timestamp, result (`not_home`, `spoke`, `refused`, `moved`, `deceased`, `do_not_knock`, `inaccessible`), support (1–5 or null), issues (tag array), wants_sign, wants_volunteer, needs_ride, follow_up, note. Append-only; latest per voter is a view.
- `user` — email, name, role (`admin`, `organizer`, `volunteer`), password hash, invite token, active.
- `audit_log` — who viewed/exported what, when (needed to show the list was handled properly).
- `import_run` — hash of the source files and row counts so re-imports are traceable.

## Features by role

Volunteer (phone): my turfs → list of doors sorted along the street → tap a door → household card (voters, ages n/a, last contact) → one-thumb result buttons → optional support/issues/note → next door. Map view of the turf with colour by status. Works offline for the assigned turf; queued writes sync on reconnect. Sees only households in their assigned turfs; never sees exports or other turfs.

Organizer (laptop/tablet): everything a volunteer has, plus the whole-municipality map with layers (ward, community, non-resident owners, institutions, contacted / not contacted, support), turf drawing (polygon or "pick streets"), assigning turfs, the progress dashboard (doors knocked per day, coverage % by ward/community, support distribution), search by name / address / street, follow-up queue, CSV export (audited).

Admin: user management and invites, import/re-import of a fresh voters list (diffs shown: new / removed / moved voters), settings, purge.

## Phases

1. **Foundation + read-only viewer** (this session)
   compose stack, schema + importer from `voters_final.csv` / `households.csv`, login with roles and invites, full-municipality map (clustered households, ward/community filters, search, household card), stats dashboard. Deployable and useful on its own.
2. **Canvassing core**
   turfs (draw + street-pick), assignments, the door screen with result buttons and notes, latest-status colouring on the map, follow-up queue, per-user activity.
3. **Field hardening**
   PWA install, offline turf cache with a sync queue, walking order along streets, "near me" ordering with device GPS, print a turf sheet as a fallback.
4. **Reporting + admin**
   coverage and support reports by ward/community/turf/day, CSV export with audit entries, list re-import with diff, purge, backup script (pg_dump → encrypted archive).

## Deliverable layout

```
canvass/
  docker-compose.yml       caddy, web, api, db, importer
  Caddyfile                TLS (Let's Encrypt or internal CA), proxy rules
  .env.example             DOMAIN, POSTGRES_PASSWORD, JWT_SECRET, ADMIN_EMAIL
  db/                      schema.sql, views.sql, migrations/
  importer/                Python: loads pipeline CSVs, geometry, import_run record
  api/                     Fastify + TypeScript, zod validation, pg, JWT cookies, RBAC
  web/                     Vite + React + TypeScript, MapLibre GL, PWA
  data/                    voters_final.csv, households.csv (git-ignored)
  Makefile                 up, down, import, backup, purge, logs
  README.md                deploy on the Ubuntu VM / Hyper-V box, first login, adding volunteers
```

## Open decisions (defaults in brackets)

- Domain and TLS: public domain with Let's Encrypt via Caddy [assume a subdomain on an ecoworks.ca-managed domain], or LAN-only with a self-signed cert.
- Login: email + password with invite links [default], or Google sign-in.
- Map library: MapLibre GL [default — smooth with 7k points and vector clustering] vs Leaflet.
- Support scale: 1–5 [default] vs 3-way (for / undecided / against).
- Whether volunteers may see voter names or only household counts [default: names — needed at the door — but no mailing addresses or non-resident details].
