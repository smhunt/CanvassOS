# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Self-hosted voter map + canvassing tool for the Sean Hunt mayoral campaign (Middlesex Centre, Ontario;
election day 2026-10-26). `prompt_plan.md` holds the 4-phase build plan and a dated status section.

**Shipped today:** Phase 1 (import, auth/roles, map/search/stats), Phase 2 (turfs from streets or a
drawn polygon, assignments, the door screen, contact history, follow-up queue, activity, turf
reassignment) and Phase 3 (offline write queue + separate sign-photo queue + turf cache in
`web/src/offline/`, nearest-first door ordering, the printable turf sheet, add-to-home-screen, a real
tablet layout), plus three things that were never in the plan — **lawn signs** (GPS, accuracy,
photos, pickup and delivery lists), **doorstep phone/email with per-purpose consent**, and
**optional street-level imagery of a door** (off unless `STREETVIEW_API_KEY` is set). Phase 4
(coverage reports, CSV export with audit, diff re-import) is not started.

Data as loaded: **7,140 households, 16,892 electors**, 7,067 mapped, 70 legal descriptions, 3 that
would not geocode at all, 11 institutions.

Four docs are the contract; keep them in sync when you change behaviour:
- `API.md` — the full endpoint/role contract (request shapes, response shapes, audit actions, env vars).
- `README.md` — deploy (both modes), import, migrations, backup/restore/purge, importer field mapping,
  the pipeline, `web/Dockerfile` contract.
- `docs/README.md` — architecture: diagrams, data model, role model, request lifecycle, the
  offline/idempotency contract (§6, both queues), the breakpoint scale and the paper sheet (§7).
- `prompt_plan.md` — phases, current status, and what is deliberately deferred.

## Legal constraint that shapes the design

The voters list is personal information under Ontario's *Municipal Elections Act, 1996* (s. 23(7)–(8)).
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

make demo                     # drop + rebuild canvass_demo (schema.sql, migrations, fabricated seed)

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

**Anything shareable comes off the demo stack.** `make demo` rebuilds `canvass_demo` with entirely
fabricated residents (deterministic, real public street names, invented people) — use it for
screenshots, recordings and walkthroughs so nothing leaving the campaign contains a real elector.
Accounts and rules: `demo/README.md`. `web/tools/e2e.py` drives the *real* database and writes to the
git-ignored `web/screenshots/`.

```bash
cd api && set -a && . ../.env.demo && set +a && npx tsx watch src/server.ts   # demo API 3132
cd web && CANVASS_WEB_PORT=3032 CANVASS_API_PORT=3132 npm run dev             # demo web 3032

OPENAI_API_KEY=… ./demo/make_video.sh    # the 60s explainer -> demo/mc-canvass-60s.mp4
```

`make_video.sh` is deterministic (one narration file per scene, each still held for exactly its own
audio length; `demo/tts.py` uses OpenAI TTS and falls back to macOS `say`). Its scene stills are
referenced by absolute paths into throwaway capture directories, so re-point them before a rebuild.
`demo/build/` is git-ignored.

## Architecture

```
browser (PWA) --https--> caddy ──/api/*──> api (Fastify/TS) ──> postgres (postgis image)
                           └── static /srv (SPA built by the `web` build-only container)
                                                api ──> sign photos on the `signphotos` volume
                                                api ──> Google Street View Static  (OPTIONAL, off
                                                        by default; two coordinates out, nothing stored)
importer (one-shot python) ──────────────────────────────────> postgres
```

Basemap tiles (OSM/CARTO/Esri) are fetched by the browser and never touch the stack; map glyphs are
self-hosted. The server makes exactly **two** outbound calls, both off unless a key is configured:
Street View (`api/src/lib/streetview.ts`, two coordinates out, nothing stored) and the reachability
advice (`api/src/lib/advice.ts`, aggregate counts out, to Anthropic). Both go through
`app.httpFetch` so tests stub them and no test ever makes a billed call.

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
`002_voter_contact.sql`. Run new migrations against `canvass_test` as well, or the suite drifts out
of shape; `make demo` already applies them to `canvass_demo` when it rebuilds it.

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

**`make import-force` is wider than its name suggests.** `--force` runs `TRUNCATE household CASCADE`,
and Postgres truncates *every* referencing table regardless of its `ON DELETE` action — so it also
empties `voter`, `contact`, `sign`, `sign_photo`, `voter_contact` and `turf_household`, and leaves the
photo **files** orphaned on the volume (the importer says so; it does not delete them). The guard now
counts and **names all five dependent tables** before refusing (exit 2) — it used to count `contact`
alone, which let `--force` quietly destroy lawn signs and doorstep consent records. `to_regclass` is
checked per table so a database predating a migration still works. If you add a table with an FK to
`household`, add it to the `dependents` list in `importer/import.py` in the same commit. Back up
first. (Phase 4 is where the diff-based re-import lands.)

**`api/src/lib/serialize.ts` is the single enforcement point for role-based field stripping**, and
`api/src/lib/scope.ts` is the single enforcement point for volunteer turf scoping. Every row leaving the
API goes through a `serialize*` function, and those are explicit allow-lists (keys picked, never
deleted) so an extra column in a SQL projection — or an insert's `RETURNING *` — cannot leak. Add a
field there deliberately, on the right role branch; never return a raw row from a route.

**Volunteers are scoped, not blinded.** Phase 2's rule is exactly one sentence: a volunteer may read and
write the doors of the turfs assigned to them, and nothing else. `assertTurfAccess` /
`assertHouseholdAccess` throw `403 not_your_turf`, and they run **before** the row is loaded so a 404
never leaks the existence of an id. `GET /api/households/:id/streetview` reuses the same helper — one
implementation, not a second one that drifts. Map points now carry `status` for in-turf doors only, and that scope
is a CTE inside the query — out-of-turf contact rows are never fetched, not fetched then stripped.
Municipality-wide reads (`/search`, `/streets`, `/stats/overview`, `/households/legal`, `/follow-ups`,
`/activity`, `/voter-contacts/gotv`) stay organizer-or-above. `GET /api/users` is organizer-and-above so
the assign picker works, and `serializeUserListRow` gives a non-admin only `{ id, name, role, active }`.

**Idempotency keys are derived, not echoed.** `contact.client_id` and `sign.client_id` are UNIQUE.
`POST /api/contacts` writes one row per named voter, so it stores `<client_id>:<voter_id>` per row (a
door-level row with nobody named keeps the key verbatim). **A client that looks its own submission up
by the key it minted will not find it** — `web/src/offline/outbox.ts` therefore keys entries by the id
it generated (`entry.id` *is* the `client_id`) and reads the response only for its data. `201` =
something was created, `200` = it was all already there, and a replay is not re-audited. **Generate
`client_id` once, at the first attempt, and store it with the body**; regenerating it on retry turns
one door into two, which is why `enqueue` refuses an entry with no key. A queued write must also not
claim it was recorded: `usePlaceSign` returns a locally-built row with `queued: true`. The one thing
the response body *is* read for is a sign's real id, handed to the photo queue — below. Full contract
in `docs/README.md` §6.

**Sign photos are a second, separate queue and must stay one.** `web/src/offline/photoQueue.ts` holds
image blobs in their own IndexedDB store, keyed by the sign's `client_id` — the only identifier that
exists when the shutter is pressed. It is deliberately *not* an outbox entry type: the outbox is a
JSON queue whose per-entry counts drive the pill a volunteer reads as "how many doors are still on my
phone", and an 8 MB blob sharing that retry budget and that number is the bug this split prevents.
The hand-over is an explicit one-way call — `outbox.flush()` calls `adoptSignId(entry.id, res.sign.id)`
— never a timer, a poll or a subscription, so nothing has to be mounted for a photo taken in a field
to become uploadable. Uploads are the one route that bypasses `api/client.ts` (multipart by hand),
with failures converted to `ApiError` so they classify like everything else; its 4xx set is its own
(413/400 are permanent verdicts on those bytes, 404 means the sign is gone). Read the file header
before changing any of it.

**Voter data on a phone: two deliberate exceptions, one button.** The service worker still never
caches `/api/*`, but `web/src/offline/turfCache.ts` puts a turf's door list — names included — into
IndexedDB, and `photoQueue.ts` holds photographs of electors' houses until they upload. Keep their
scope: the turf cache is written only when a turf is actually opened (by `useDoors`, nothing else),
only for turfs the API agreed to serve that user; a held photo is deleted the moment it lands, when
its sign is discarded, or with the clear button. **"Clear saved turf data" must keep clearing both** —
`clearTurfCache()` calls `clearPendingPhotos()`, and the capture screen says so at capture time.
`make purge` cannot reach a phone, which is why that button exists. `localStorage` is for UI
preferences only (base layer, door-order toggle, the install banner's "not now"), always in try/catch.

**Street View imagery must never be stored — not on disk, not in memory, not in a cache.** Google's
Maps Platform ToS §3.2.3 bars pre-fetching/storing/caching Maps Content; the *only* carve-out
(Service Specific Terms §A.3) is `pano_ID` values, and that is exactly what the single cache in
`api/src/lib/streetview.ts` holds. Bytes pass straight to the reply and are unreferenced. An earlier
draft had a short byte cache to avoid double-billing; reading §3.2.3 is what removed it. The other
three rules are just as load-bearing: **only two coordinates leave the server** (never a name,
address string or household id), **the key never reaches the browser** (a client-side key would leak
"which doors, in what order, by whom" via the Referer), and the **free metadata endpoint is checked
first** so a road with no imagery costs nothing and yields a truthful 404. Scoped with the same
`assertHouseholdAccess` as the door, rate-limited **per user** (40/min — a canvassing team shares one
LTE NAT), `w`/`h` capped at 640 because every pixel size is a separate charge, and audited on both
outcomes. `app.httpFetch` is the injection point; no test ever makes a billed call.

**The advice layer may only ever be sent counts.** `api/src/lib/advice.ts` posts the reachability
report to Anthropic so it comes back as prose. The *Municipal Elections Act* s. 23(8) rule that
shapes `streetview.ts` applies here with more force — a row in a prompt is the list "provided to
another person". So: `AdviceInput` has no field that can carry a row; `assertNoPersonalData()`
re-checks the serialised payload before it leaves, because "the type says it is safe" stops being
true the day someone widens the type; the cache is keyed on a hash of the exact facts sent, so
identical numbers are never re-billed; `ADVICE_API_KEY` absent = the whole thing off and the report
renders its own written guidance; and every failure path returns null, because the numbers are the
product and the prose is a garnish. The suite asserts the outgoing body against real elector names
and addresses from the loaded database — keep that test.

**The print stylesheet stays loaded, so its rules are scoped behind a body class.**
`web/src/print/print.css` is imported by the `/turfs/:turfId/sheet` chunk, and a lazily-loaded
stylesheet is never removed from the document. `TurfSheetPage` adds `printing-sheet` to `<body>` on
mount and removes it on unmount; without that class on the rules, visiting the sheet once would
silently break printing on every other page for the rest of the session. `@page` deliberately does
not name a paper size — margins fit both A4 and Letter, and `size: A4` makes a Letter tray shrink the
page. Nothing on the sheet may depend on colour: it comes off a mono laser printer.

**Four breakpoints, no fifth number.** The scale is documented at the top of `web/src/styles.css`:
phone (unqualified), compact `max-width: 479.98px`, tablet `min-width: 720px`, desktop
`min-width: 1100px`; plus `and (min-height: 600px)` for anything wanting two panes and
`(orientation: landscape) and (max-height: 500px)` for a phone on its side. Max-width stops sit at
`.98` because `max-width: 720px` and `min-width: 720px` both match at 720. **Density is never
tightened by width** — `(pointer: coarse)` and `(hover: hover)` are what say "a finger is doing
this", and tap targets never shrink. The tablet stop is duplicated in TypeScript
(`web/src/canvass/useBreakpoint.ts`, `TABLET_QUERY`) because the ARIA has to flip with the layout:
`DoorSheet`'s `variant: 'sheet'` is a real modal dialog (scrim, `aria-modal`, Escape) and `'pane'` is
a plain labelled region beside a list that is still usable. Change the CSS stop and the constant
together.

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
- `src/lib/streetview.ts` is the optional third-party door photo (`GET /api/households/:id/streetview`).
  `app.httpFetch` is decorated in `app.ts` so it can be stubbed; `STREETVIEW_API_KEY` absent = the
  whole feature off, answered with `503 streetview_disabled` before the database is touched. See the
  landmine above before touching any of it.
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
  `tools/make_glyphs.py`); basemap tiles do come from OSM/CARTO/Esri. `src/map/StreetView.tsx` is a
  plain `<img>` at our own endpoint that renders **nothing** on 503 or 404, and offers no download,
  share or open-in-new-tab — it is a photograph of an elector's house.
- Turf reassignment (`src/turfs/AssigneeList.tsx`, `AssignDialog.tsx`): a turf can carry several
  assignees, and **there is no move endpoint** — the client assigns then unassigns, in that order, so
  a half-completed move leaves one person too many (fixable in a tap) rather than doors nobody is
  walking. When the unassign fails, the dialog says exactly that and drops into the remove step; it
  must never report a half-move as a move.
- Every heavy route is `lazy()`-loaded (map, door screen, turf builder, turf sheet, reports, signs) so
  Vite splits it into its own chunk; `manualChunks` in `vite.config.ts` names only two — `maplibre`
  (~1 MB) and `vendor` (react, router, query).
- `src/offline/` is the field layer: `db.ts` (IndexedDB v2, **four** stores — `outbox`, `turf_cache`,
  `meta`, `pending_photos` — no library, with a loud in-memory fallback surfaced as
  `snapshot.durable === false`), `outbox.ts` (`submitOrQueue`, backoff 5 s → 5 min, parked after 20
  attempts and surfaced rather than dropped; a 400/403/404 is re-thrown at the door, a 401 is queued),
  `photoQueue.ts` (the separate blob queue — see the landmine), `turfCache.ts`, `useOutbox.ts`
  (`useOutbox` / `usePhotoQueue` / `usePendingPhotosFor` / `useQueuedResults`; subscribing starts the
  queue). `useDoors` writes the cache and falls back to it on a network failure — but **not** on
  401/403/404, which are definite answers about that turf. It runs `networkMode: 'always'` and
  `retry: false` on purpose, as do the two write mutations. `useOfflineSync` invalidates the affected
  queries once a flush lands.
- `src/pwa.ts` owns service-worker registration (production only) and the add-to-home-screen offer: it
  preempts `beforeinstallprompt` on Chrome/Edge and, because iOS Safari never fires it, shows written
  instructions there instead — never on `/login` or `/invite`, and a dismissal is remembered.
- `src/canvass/useBreakpoint.ts` + the breakpoint scale at the top of `src/styles.css`; `src/print/`
  is the paper sheet. Both have landmines above.
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
  already-applied migration. If the new table references `household`, add it to `dependents` in
  `importer/import.py` too.
- A new audit-worthy read or change extends the `AuditAction` union in `api/src/lib/audit.ts`; never
  pass a loose string.
- A new media query uses one of the four stops in `web/src/styles.css` — a fifth number is a bug, and
  so is a `max-width` that shares an edge with a `min-width`.
