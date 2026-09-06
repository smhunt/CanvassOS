# Middlesex Centre Canvass — build plan

Self-hosted (Docker) voter map + canvassing tool for the Sean Hunt mayoral campaign.
Users: Sean (admin), a small core team (organizers), volunteers on phones at the door.

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
