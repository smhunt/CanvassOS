# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Self-hosted voter map + canvassing tool for the Sean Hunt mayoral campaign (Middlesex Centre, Ontario;
election day 2026-10-26). `prompt_plan.md` holds the 4-phase build plan and a dated status section.

**Shipped today:** Phase 1 (import, auth/roles, map/search/stats), Phase 2 (turfs from streets or a
drawn polygon, assignments, the door screen, contact history, follow-up queue, activity) and most of
Phase 3 (offline outbox + turf cache in `web/src/offline/`, nearest-first door ordering, the printable
turf sheet), plus two things that were never in the plan — **lawn signs** (GPS, accuracy, photos,
pickup and delivery lists) and **doorstep phone/email with per-purpose consent**. Phase 4 (coverage
reports, CSV export, diff re-import) is not started.

Data as loaded: **7,140 households, 16,892 voters**, 7,067 mapped, 70 legal descriptions, 11
institutions.

Four docs are the contract; keep them in sync when you change behaviour:
- `API.md` — the full endpoint/role contract (request shapes, response shapes, audit actions, env vars).
- `README.md` — deploy (both modes), import, migrations, backup/restore/purge, importer field mapping,
  the pipeline, `web/Dockerfile` contract.
- `docs/README.md` — architecture: diagrams, data model, role model, request lifecycle, the
  offline/idempotency contract.
- `prompt_plan.md` — phases, current status, and what is deliberately deferred.

## Legal constraint that shapes the design

The voters list is personal information under Ontario's *Municipal Elections Act, 1996* (s. 23, s. 88).
That is why the code looks the way it does, and changes must not erode it: TLS only, login on every
page, role-gated fields, volunteers scoped to their assigned turfs, `audit_log` writes on every read of
personal data, encrypted backups, `make purge` after the election. Never commit CSVs, screenshots of
real data, sign photos, or `.env` (see `.gitignore`).

**`voter_contact` (phone/email collected at the door) is not list data** and has its own rule: consent
is per purpose, it may only be used for what was consented to, and withdrawal is *stamped, never
deleted*. Canada's Anti-Spam Legislation, not the MEA, is the governing constraint there. Do not merge
it into anything that exports the voters list.

## Commands

Operator/production (run from the repo root on the Docker host — see the `Makefile`):

```bash
make up                       # mode A: Caddy binds 80/443, Let's Encrypt for $DOMAIN
make up-tunnel                # mode B (CURRENT): Caddy on 127.0.0.1:3031 behind a Cloudflare Tunnel
make devdb                    # tunnel mode + database published on 127.0.0.1:5443 (never on a public host)
make restart-tunnel           # rebuild api/web/caddy in tunnel mode, leaving db alone (--no-deps: see the Makefile)
make tunnel-status            # curl the loopback origin's /api/health

make migrate                  # apply pending db/migrations/*.sql   (make migrate-status to list them)
make import LABEL="voters list export 2026-09-03"   # one-shot importer (compose profile "import")
make import-force             # re-import when contacts exist — DESTRUCTIVE, see the landmine below

make logs SERVICE=api  |  make ps  |  make psql  |  make restart  |  make down  |  make build
make backup                   # pg_dump | gzip | gpg AES256 -> backups/canvass-<stamp>.sql.gz.gpg
make restore FILE=backups/...gpg
make purge                    # post-election: drops volumes, shreds data/*.csv and sign photos (types PURGE)
```

Local development (ports: **web 3030, API 3130, Postgres 5443**; demo web 3032 / API 3132;
tunnel origin 3031; `vite preview` 4173):

```bash
make devdb                    # publishes the stack's database on 127.0.0.1:5443

# API — env lives in .env.dev (git-ignored)
cd api && npm install
env $(grep -v '^#' ../.env.dev | xargs) npm run dev   # tsx watch on 3130
npm run typecheck             # tsc --noEmit (also `npm run build`)

cd web && npm install && npm run dev        # https://dev.ecoworks.ca:3030; /api proxied to 3130
npm run typecheck && npm run build          # tsc then vite build (must emit /app/dist for the image)
python3 tools/e2e.py                        # Playwright smoke run against `vite preview` (4173) + API 3130

# Migrations against a non-production database
PSQL="psql postgresql://canvass:pw@localhost:5443/canvass_test" ./db/migrate.sh

# Rebuild the importer's CSVs from the raw sources (needs openpyxl)
python3 pipeline/build_lists.py --xlsx <clerk list>.xlsx --addresses Address.geojson --out-dir data
```

Tests — **opt-in and destructive**, see the landmine below:

```bash
cd api
CANVASS_TEST_DESTRUCTIVE=1 \
  TEST_DATABASE_URL=postgresql://canvass:$POSTGRES_PASSWORD@localhost:5443/canvass_test \
  npm test
npm test -- --test-name-pattern 'points'    # single test / describe (node:test filter)
```

`api/test/api.test.ts` is an integration suite: it needs a database already loaded by the importer and
migrated, and it derives expected counts from `../data/*.csv` (`CANVASS_DATA_DIR` overrides). It is the
regression net for the role rules — assertions check that volunteer responses carry none of
`mailing_address`, `mail_city`, `mail_postal`, `resident_class`, `n_nonresident`, `n_po_box`.
`api/test/geo.test.ts` is a pure unit test for the point-in-polygon maths and needs no database.

Vite serves HTTPS from the shared mkcert cert at `~/Code/.traefik/certs/`, so dev is
`https://dev.ecoworks.ca:3030` — never `localhost`. Production is unaffected: Caddy owns the edge and
the API keeps its internal 3000. Note that PORTS.md's "Available Ports" table is stale (it lists
3081/3083/3090 as free while the same file assigns them elsewhere), so grep the whole file before
claiming a number.

**Anything shareable comes off the demo stack.** `demo/seed_demo.py` seeds `canvass_demo` with entirely
fabricated residents (deterministic, real public street names, invented people) — use it for
screenshots, recordings and walkthroughs so nothing leaving the campaign contains a real elector.
`web/tools/e2e.py` drives the *real* database and writes to the git-ignored `web/screenshots/`.

## Architecture

```
browser (PWA) --https--> caddy ──/api/*──> api (Fastify/TS) ──> postgres (postgis image)
                           └── static /srv (SPA built by the `web` build-only container)
                                                api ──> sign photos on the `signphotos` volume
importer (one-shot python) ──────────────────────────────────> postgres
```

Five compose services in `docker-compose.yml`: `db`, `api`, `web`, `caddy`, `importer` (profile
`import`). Volumes: `pgdata`, `webroot`, `signphotos`, `caddy_data`, `caddy_config`.

**Two deployment modes.** `make up` is the public-host form: Caddy binds 80/443 and gets its own Let's
Encrypt cert. `make up-tunnel` overlays `docker-compose.tunnel.yml` + `Caddyfile.tunnel` for the current
setup — the stack runs on the office Mac, Caddy serves plain HTTP on `127.0.0.1:3031`, and a Cloudflare
Tunnel publishes it as canvass.sean-hunt.com with TLS at the edge. In tunnel mode Caddy rewrites
`X-Forwarded-For` from `CF-Connecting-IP`; without that every `audit_log` row would record the tunnel's
own address, which would gut the MEA artefact. `docker-compose.devdb.yml` is a third overlay that
publishes the database on loopback for dev/test. See README "Deploying behind a Cloudflare Tunnel".

Phase 1's `lat`/`lon` columns are still the geometry story: turf polygons are bbox-filtered in SQL and
then point-in-polygon'd in TypeScript (`api/src/lib/geo.ts`), so the schema still runs on bare Postgres.
`CREATE EXTENSION postgis` has never been run — PostGIS is available in the image if something ever
genuinely needs a spatial operator.

### Landmines

**Schema is applied once, on first boot**, via `db/schema.sql` mounted into
`/docker-entrypoint-initdb.d/` — it only ever runs against an empty database. Every change after that
is a file in `db/migrations/`, applied with `make migrate` (`make migrate-status` to see what is
pending) and recorded in `schema_migration`. **Never edit `db/schema.sql` to change a live stack**; it
will not re-run, and the two will silently diverge. Applied so far: `001_signs.sql`,
`002_voter_contact.sql`. Run new migrations against `canvass_test` and `canvass_demo` as well, or the
suite and the demo drift out of shape.

**The test suite has rails; keep them.** `api/test/api.test.ts` throws at import time unless
`CANVASS_TEST_DESTRUCTIVE=1`, and refuses any database named `canvass` (or an unparseable URL). It
creates its own users as `<who>+<run id>@test.local` and `after()` deletes exactly the rows that run
created, by id. It **no longer truncates `app_user` / `session` / `audit_log`** — that rule exists
because it once wiped the admin account and the audit log of a running system. Do not reintroduce a
truncate, and do not weaken either check to make a test easier to run.

**`web` is build-only and this is easy to break.** It runs
`sh -c "rm -rf /srv/* && cp -r /app/dist/. /srv/"` into the shared `webroot` volume and exits; Caddy
`depends_on` it with `service_completed_successfully`. So `web/Dockerfile`'s final stage must contain
`/app/dist` plus `sh`/`rm`/`cp` — an `alpine`-family base, never `scratch` or an nginx image. No nginx
anywhere: Caddy serves the files with `try_files {path} /index.html`.

**`make import-force` is wider than its name suggests.** The importer refuses (exit 2) when `contact`
rows exist, but `--force` runs `TRUNCATE household CASCADE`, and Postgres truncates *every* referencing
table regardless of its `ON DELETE` action — so that also empties `voter`, `contact`, `turf_household`,
`sign`, `sign_photo` and `voter_contact`, and leaves the photo files orphaned on the volume. The guard
only counts `contact`. Back up first. (Phase 4 is where the diff-based re-import lands.)

**`api/src/lib/serialize.ts` is the single enforcement point for role-based field stripping**, and
`api/src/lib/scope.ts` is the single enforcement point for volunteer turf scoping. Every row leaving the
API goes through a `serialize*` function, and those are explicit allow-lists (keys picked, never
deleted) so an extra column in a SQL projection — or an insert's `RETURNING *` — cannot leak. Add a
field there deliberately, on the right role branch; never return a raw row from a route.

**Volunteers are scoped, not blinded.** Phase 2's rule is exactly one sentence: a volunteer may read and
write the doors of the turfs assigned to them, and nothing else. `assertTurfAccess` /
`assertHouseholdAccess` throw `403 not_your_turf`, and they run **before** the row is loaded so a 404
never leaks the existence of an id. Map points now carry `status` for in-turf doors only, and that scope
is a CTE inside the query — out-of-turf contact rows are never fetched, not fetched then stripped.
Municipality-wide reads (`/search`, `/streets`, `/stats/overview`, `/households/legal`, `/follow-ups`,
`/activity`, `/voter-contacts/gotv`) stay organizer-or-above. `GET /api/users` is organizer-and-above so
the assign picker works, and `serializeUserListRow` gives a non-admin only `{ id, name, role, active }`.

**Idempotency keys are derived, not echoed.** `contact.client_id` and `sign.client_id` are UNIQUE.
`POST /api/contacts` writes one row per named voter, so it stores `<client_id>:<voter_id>` per row (a
door-level row with nobody named keeps the key verbatim). **A client that looks its own submission up
by the key it minted will not find it** — `web/src/offline/outbox.ts` therefore keys entries by the id
it generated and reads the response only for its data. `201` = something was created, `200` = it was
all already there, and a replay is not re-audited. Generate `client_id` once, at the first attempt, and
store it with the body; regenerating it on retry turns one door into two. Full contract in
`docs/README.md` §6.

**Voter data on a phone: the turf cache is the single deliberate exception.** The service worker still
never caches `/api/*`, but `web/src/offline/turfCache.ts` puts a turf's door list — names included —
into IndexedDB. Keep its scope: written only when a turf is actually opened (by `useDoors`, nothing
else), only turfs the API agreed to serve that user, and clearable from the sync panel. `make purge`
cannot reach a phone, which is why that button exists. `localStorage` is for UI preferences only.

### API (`api/`, Fastify 4 + TypeScript, ESM, `pg` pool, zod, no ORM)

- `src/app.ts` builds the instance (`buildApp({ config, db })` — tests inject their own pool) and owns
  the uniform error envelope `{ error: { code, message } }`. Throw `ApiError` (`src/lib/errors.ts`)
  rather than replying with an ad-hoc shape; `ZodError` is translated automatically.
- `src/auth/guard.ts` registers one global `onRequest` hook that resolves the session cookie into
  `req.session`; routes opt in with the `requireAuth` / `requireRole('organizer')` preHandlers.
- Sessions are rows in `session`; the cookie (`canvass_sid`, signed by `@fastify/cookie`) is the session
  id, with a 30-day sliding expiry bumped at most once a day (`src/auth/session.ts`). Passwords are
  argon2id; invite tokens are stored sha256-hashed and the raw token appears only in `invite_url`.
- `bootstrapAdmin` creates the first admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` **only when `app_user` is
  empty**; afterwards those vars are ignored.
- Every read of personal data writes `audit_log` via `src/lib/audit.ts`. The action union is the
  authoritative list — extend it rather than passing a loose string. Audit failures are logged, never
  turned into a 500.
- Sign photos: `@fastify/multipart` is registered app-wide in `app.ts` (it is `fastify-plugin`-wrapped,
  so it applies however it is registered) with the photo endpoint's limits — 1 file, 8 MB.
  `src/lib/images.ts` sniffs magic bytes; **the declared content-type is never trusted**, the sniffed
  one is what gets stored and later served. Filenames are discarded and files are written under a
  generated uuid with `flag: 'wx'`. Bytes live on disk (`SIGN_PHOTO_DIR`), metadata in `sign_photo`, and
  `path` is never serialized.
- ESM + `NodeNext`: relative imports must carry the `.js` extension even in `.ts` sources.

### Web (`web/`, Vite + React 18 + TypeScript, react-router 6, TanStack Query, MapLibre GL)

- `src/api/client.ts` is the only fetch wrapper (same-origin `/api`, `ApiError`, a 401 listener that
  clears the session); `src/api/hooks.ts` holds every query/mutation; `src/api/types.ts` mirrors `API.md`.
- `src/auth.tsx` has the client-side role gates (`RequireAuth`, `RequireRole`) — cosmetic only; the API
  is the real boundary, so never rely on them for data protection.
- Map: `src/map/style.ts` builds the whole MapLibre style (all three raster base layers present, toggled
  by `visibility`, so switching never drops our GeoJSON sources); `src/map/palette.ts` is the shared
  colour source for map, legend and stats; `src/map/DrawPolygon.tsx` + `drawGeometry.ts` are the turf
  draw tool, and its live preview uses the **same ray cast as the server** so it cannot promise a
  different turf from the one that gets saved. Glyphs are self-hosted from `public/fonts` (generated by
  `tools/make_glyphs.py`); basemap tiles do come from OSM/CARTO/Esri.
- Everything heavy is `lazy()`-loaded and manually chunked in `vite.config.ts` — MapLibre (~1 MB), the
  door screen, the turf builder, the turf sheet, reports and signs.
- `src/offline/` is the field layer: `db.ts` (IndexedDB, three stores, no library, with a loud
  in-memory fallback), `outbox.ts` (`submitOrQueue`, backoff 5 s → 5 min, parked after 20 attempts and
  surfaced rather than dropped), `turfCache.ts`, `useOutbox.ts`. `useDoors` writes the cache and falls
  back to it on a network failure — but **not** on 401/403/404, which are definite answers about that
  turf. It runs `networkMode: 'always'` and `retry: false` on purpose.
- `vite.config.ts` reads `CANVASS_WEB_PORT` / `CANVASS_API_PORT` so a second stack (the demo) can run
  alongside the first.
- The service worker is generated at build time by an inline Vite plugin in `vite.config.ts`: it
  precaches the app shell only and **never caches `/api/*`** (voter data must not sit in a browser
  cache). The only thing the SPA persists is a map UI preference in `localStorage`.

### Importer (`importer/import.py`, one file, stdlib + psycopg) and pipeline

sha256s both CSVs into `import_run`; a re-run on identical files is a no-op; a different file truncates
and reloads in one transaction; it refuses (exit 2) when `contact` rows exist unless `--force` (see the
landmine). It verifies row counts and per-ward/community totals after loading and rolls back on any
mismatch. Field mapping lives next to each column and in README.md — including the known quirks:
duplicate list entries get a `#2` suffix on `natural_key` (which is UNIQUE), and `household.n_nonresident`
sums to 394 (it includes the 4 `resident_class = 'unknown'` voters) while `/api/stats/overview` reports
390.

`pipeline/build_lists.py` rebuilds those CSVs from the clerk's `.xlsx` plus county open address data.
**It is a reconstruction** — the original pipeline was lost — and its `resident_class` differs
materially from the original's (390 non-residents vs the original 337). Treat the non-resident layer as
indicative; confirm at the door.

## Conventions

- Commits are small and typed (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`); commit as soon as a unit
  of work passes.
- Comments in this codebase explain *why* (the legal rule, the compose contract, the pg quirk), not what.
  Match that density rather than annotating obvious code.
- When you add or change an endpoint, update `API.md` in the same commit, extend `api/test/api.test.ts`,
  and — if a personal-data field is involved — add it to the `serialize.ts` allow-list and to the
  restricted-key assertions in the test suite.
- A schema change is a new numbered file in `db/migrations/`, never an edit to `db/schema.sql` or to an
  already-applied migration.
