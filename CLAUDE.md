# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Self-hosted voter map + canvassing tool for the Sean Hunt mayoral campaign (Middlesex Centre, Ontario;
election day 2026-10-26). `prompt_plan.md` holds the 4-phase build plan; **Phase 1 (import, auth/roles,
read-only map/search/stats) is what exists today**. Phase 2+ tables (`turf`, `assignment`, `contact`) are already in the
schema, so Phase 1 endpoints return zeroed/null canvass fields without needing a migration. The
`household_status` / `voter_status` views exist too but are currently **unused** — routes inline the
equivalent `LEFT JOIN LATERAL` instead, so if you change one, change the other or drop the views.

Three docs are the contract; keep them in sync when you change behaviour:
- `API.md` — the full endpoint/role contract (request shapes, response shapes, audit actions, env vars).
- `README.md` — deploy, import, backup/restore/purge, importer field mapping, `web/Dockerfile` contract.
- `prompt_plan.md` — phases and what is deliberately deferred.

## Legal constraint that shapes the design

The voters list is personal information under Ontario's *Municipal Elections Act, 1996* (s. 23, s. 88).
That is why the code looks the way it does, and changes must not erode it: TLS only, login on every page,
role-gated fields, `audit_log` writes on every read of personal data, encrypted backups, `make purge`
after the election. Never commit CSVs, screenshots of real data, or `.env` (see `.gitignore`).

## Commands

Operator/production (run from repo root on the Docker host — see the `Makefile`):

```bash
make up                       # build + start db, api, web(build-only), caddy
make import LABEL="voters list export 2026-09-03"   # one-shot importer (compose profile "import")
make import-force             # re-import when contacts exist — DELETES contacts (Phase 4 adds a diff)
make logs SERVICE=api  |  make ps  |  make psql  |  make restart  |  make down
make backup                   # pg_dump | gzip | gpg AES256 -> backups/canvass-<stamp>.sql.gz.gpg
make restore FILE=backups/...gpg
make purge                    # post-election: drops volumes, shreds data/*.csv (types PURGE to confirm)
```

Local development:

```bash
# db: plain Postgres 16 is enough in Phase 1; apply db/schema.sql once
psql postgresql://canvass:canvass@localhost:5443/canvass -f db/schema.sql
# reset: DROP SCHEMA public CASCADE; CREATE SCHEMA public;  then re-apply

# importer (needs `pip install 'psycopg[binary]'`)
python3 importer/import.py --voters data/voters_final.csv --households data/households.csv \
  --label dev --database-url postgresql://canvass:canvass@localhost:5443/canvass

cd api && npm install
DATABASE_URL=postgresql://canvass:canvass@localhost:5443/canvass SESSION_SECRET=$(openssl rand -hex 32) \
  DOMAIN=localhost ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=dev-password-1 COOKIE_SECURE=false PORT=3130 \
  npm run dev            # tsx watch
npm run typecheck        # tsc --noEmit (also `npm run build`)
npm test                 # tsx --test test/*.test.ts
npm test -- --test-name-pattern 'points'   # single test / describe block (node:test filter)

cd web && npm install && npm run dev        # https://dev.ecoworks.ca:3030; /api proxied to 3130
npm run typecheck && npm run build          # tsc then vite build (must emit /app/dist for the image)
python3 tools/e2e.py                        # Playwright smoke run against `vite preview` (4173) + API 3130
```

`npm test` is an **integration** suite: it needs a database already loaded by the importer, truncates
`app_user`/`session`/`audit_log` on it, and derives every expected count from `../data/*.csv`
(`TEST_DATABASE_URL`, `CANVASS_DATA_DIR` override the defaults). It is the regression net for the role
rules — assertions check that volunteer responses carry none of `mailing_address`, `mail_city`,
`mail_postal`, `resident_class`, `n_nonresident`, `n_po_box`.

Ports (registered in `~/.claude/PORTS.md`): **web 3030, API 3130, Postgres 5443**, `vite preview` 4173.
Vite serves HTTPS from the shared mkcert cert at `~/Code/.traefik/certs/`, so dev is
`https://dev.ecoworks.ca:3030` — never `localhost`. Production is unaffected: Caddy owns 80/443 and the
API keeps its internal 3000. Note that PORTS.md's "Available Ports" table is stale (it lists 3081/3083/3090
as free while the same file assigns them elsewhere), so grep the whole file before claiming a number.

## Architecture

```
browser (PWA) --https--> caddy ──/api/*──> api (Fastify/TS) ──> postgres (postgis image)
                           └── static /srv (SPA built by the `web` build-only container)
importer (one-shot python) ──────────────────────────────────> postgres
```

Five compose services in `docker-compose.yml`: `db`, `api`, `web`, `caddy`, `importer` (profile `import`).

**`web` is build-only and this is easy to break.** It runs
`sh -c "rm -rf /srv/* && cp -r /app/dist/. /srv/"` into the shared `webroot` volume and exits; Caddy
`depends_on` it with `service_completed_successfully`. So `web/Dockerfile`'s final stage must contain
`/app/dist` plus `sh`/`rm`/`cp` — an `alpine`-family base, never `scratch` or an nginx image. No nginx
anywhere: Caddy serves the files with `try_files {path} /index.html`.

**Schema is applied once, on first boot**, via `db/schema.sql` mounted into
`/docker-entrypoint-initdb.d/`. There is no migration runner yet — changing the schema on a live stack
means writing the migration by hand (`prompt_plan.md`/schema comments anticipate `migrations/002` for
PostGIS in Phase 2). Phase 1 deliberately stores `lat`/`lon` columns rather than PostGIS geometry so the
schema also runs on bare Postgres in dev.

### API (`api/`, Fastify 4 + TypeScript, ESM, `pg` pool, zod, no ORM)

- `src/app.ts` builds the instance (`buildApp({ config, db })` — tests inject their own pool) and owns
  the uniform error envelope `{ error: { code, message } }`. Throw `ApiError` (`src/lib/errors.ts`)
  rather than replying with an ad-hoc shape; `ZodError` is translated automatically.
- `src/auth/guard.ts` registers one global `onRequest` hook that resolves the session cookie into
  `req.session`; routes opt in with the `requireAuth` / `requireRole('organizer')` preHandlers.
- **`src/lib/serialize.ts` is the single enforcement point for role-based field stripping.** Every voter
  and household row leaving the API goes through `serializeVoter` / `serializeHousehold` /
  `serializePointProps`, which are explicit allow-lists (keys picked, never deleted), so an extra column
  in a SQL projection cannot leak. Add a field there deliberately, on the right role branch — do not
  return raw rows from a route.
- Sessions are rows in `session`; the cookie (`canvass_sid`, signed by `@fastify/cookie`) is the session
  id, with a 30-day sliding expiry bumped at most once a day (`src/auth/session.ts`). Passwords are
  argon2id; invite tokens are stored sha256-hashed and the raw token appears only in `invite_url`.
- `bootstrapAdmin` creates the first admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` **only when `app_user` is
  empty**; afterwards those vars are ignored.
- Every read of personal data writes `audit_log` via `src/lib/audit.ts` (`view_household`, `search`,
  `login`, `invite`, `export`, …). Audit failures are logged, never turned into a 500.
- ESM + `NodeNext`: relative imports must carry the `.js` extension even in `.ts` sources.

### Web (`web/`, Vite + React 18 + TypeScript, react-router 6, TanStack Query, MapLibre GL)

- `src/api/client.ts` is the only fetch wrapper (same-origin `/api`, `ApiError`, a 401 listener that
  clears the session); `src/api/hooks.ts` holds every query/mutation; `src/api/types.ts` mirrors `API.md`.
- `src/auth.tsx` has the client-side role gates (`RequireAuth`, `RequireRole`) — cosmetic only; the API
  is the real boundary, so never rely on them for data protection.
- Map: `src/map/style.ts` builds the whole MapLibre style (all three raster base layers present, toggled
  by `visibility`, so switching never drops our GeoJSON sources); `src/map/palette.ts` is the shared
  colour source for map, legend and stats. Glyphs are self-hosted from `public/fonts` (generated by
  `tools/make_glyphs.py`) so no font requests leave the origin; basemap tiles do come from
  OSM/CARTO/Esri.
- MapLibre (~1 MB) is `lazy()`-loaded behind `/map` and manually chunked in `vite.config.ts`.
- The service worker is generated at build time by an inline Vite plugin in `vite.config.ts`: it
  precaches the app shell only and **never caches `/api/*`** (voter data must not sit in a browser cache).

### Importer (`importer/import.py`, one file, stdlib + psycopg)

sha256s both CSVs into `import_run`; a re-run on identical files is a no-op; a different file truncates
and reloads `household`/`voter` in one transaction; it refuses (exit 2) when `contact` rows exist unless
`--force`. It verifies row counts and per-ward/community totals after loading and rolls back on any
mismatch. Field mapping lives next to each column and in README.md — including the known quirks:
duplicate list entries get a `#2` suffix on `natural_key` (which is UNIQUE), and `household.n_nonresident`
counts 341 (includes `resident_class = 'unknown'`) while `/api/stats/overview` reports 337.

## Conventions

- Commits are small and typed (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`); commit as soon as a unit
  of work passes.
- Comments in this codebase explain *why* (the legal rule, the compose contract, the pg quirk), not what.
  Match that density rather than annotating obvious code.
- When you add or change an endpoint, update `API.md` in the same commit, extend `api/test/api.test.ts`,
  and — if a personal-data field is involved — add it to the `serialize.ts` allow-list and to the
  restricted-key assertions in the test suite.
