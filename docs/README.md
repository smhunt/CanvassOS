# Architecture & API integration

Developer orientation for `mc-canvass` — the self-hosted voter map / canvassing tool for the Sean Hunt
mayoral campaign (Middlesex Centre, Ontario; election day 2026-10-26). **Phase 1** is what exists today:
import, login with roles, read-only map / search / stats.

This file explains how the pieces fit together. It is not the operator manual and not the API contract:

| Document | Authority for |
|---|---|
| [`../README.md`](../README.md) | Deploy, `make up` / `make import`, backups, restore, purge, importer field mapping, the `web/Dockerfile` contract |
| [`../API.md`](../API.md) | The endpoint/role contract — request and response shapes, audit actions, env vars. **Authoritative.** |
| [`../prompt_plan.md`](../prompt_plan.md) | The four phases and what is deliberately deferred |
| [`../CLAUDE.md`](../CLAUDE.md) | Working conventions for changing this codebase |

The voters list is personal information supplied under Ontario's *Municipal Elections Act, 1996*
(s. 23, s. 88). That constraint is the reason for several design decisions called out below — role-gated
serialization, an `audit_log` write on every read of personal data, and a service worker that never
caches `/api/*`. The policy itself lives in `../README.md`.

---

## 1. System overview

```mermaid
flowchart LR
    B["Browser (PWA)<br/>React SPA + MapLibre<br/>service worker: app shell only"]

    subgraph compose["docker compose — project 'canvass'"]
        direction LR
        CA["<b>caddy</b><br/>caddy:2-alpine<br/>ports 80, 443, 443/udp<br/>Let's Encrypt for $DOMAIN"]
        WEBV[("volume: webroot<br/>built SPA at /srv")]
        API["<b>api</b><br/>Fastify 4 + TypeScript<br/>expose 3000 (internal only)"]
        DB[("<b>db</b><br/>postgis/postgis:16-3.4<br/>volume: pgdata")]
        IMP["<b>importer</b><br/>profile: import<br/>python:3.12-slim, one-shot"]
    end

    CSV["data/voters_final.csv<br/>data/households.csv<br/>(bind-mounted read-only at /data)"]

    B -- "https · GET /" --> CA
    B -- "https · /api/*" --> CA
    CA -- "static, try_files {path} /index.html" --> WEBV
    CA -- "reverse_proxy api:3000" --> API
    API -- "pg pool (max 10)" --> DB
    CSV --> IMP
    IMP -- "one transaction, then exits" --> DB
```

Not shown: a fifth service, **`web`**, which is **build-only**. It builds the SPA, runs
`sh -c "rm -rf /srv/* && cp -r /app/dist/. /srv/"` into the shared `webroot` volume, and exits;
`caddy` waits on it with `depends_on: service_completed_successfully`. There is no nginx anywhere —
Caddy serves the files itself. See "web/Dockerfile contract" in `../README.md` before touching that image.

Startup order enforced by `docker-compose.yml`: `db` (healthcheck `pg_isready`) → `api`
(healthcheck `GET /api/health`) → `web` (runs to completion) → `caddy`. The `importer` has its own
compose profile (`import`) so it never starts with the stack; `make import` runs it on demand.

Only Caddy publishes ports. `api` uses `expose`, and `db` has no host mapping at all (the commented-out
`127.0.0.1:5432` binding in `docker-compose.yml` is opt-in for debugging only).

Basemap raster tiles are fetched by the browser directly from public OSM / CARTO / Esri endpoints — they
never pass through our stack. Map glyphs are self-hosted from `web/public/fonts` so no font request
leaves the origin.

---

## 2. Tech stack

| Component | Technology | Version | Responsible for |
|---|---|---|---|
| Reverse proxy / TLS | Caddy (`caddy:2-alpine`) | 2 | Let's Encrypt cert for `$DOMAIN`, HTTP→HTTPS, `zstd`/`gzip`, security headers (HSTS, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`), static SPA with SPA fallback, `/api/*` → `api:3000` |
| Database | PostgreSQL in the PostGIS image (`postgis/postgis:16-3.4`) | PG 16 / PostGIS 3.4 | All persistence. Extensions actually used in Phase 1: `pgcrypto`, `citext`, `pg_trgm`. PostGIS is available but unused (see §4) |
| API runtime | Node.js (`node:22-alpine`), ESM, non-root user | 22 | Runs `dist/server.js` on port 3000 |
| API framework | Fastify | ^4.29.0 | HTTP server, hooks, plugin scoping, error handler |
| API plugins | `@fastify/cookie` / `@fastify/helmet` / `@fastify/rate-limit` | ^9.4.0 / ^11.1.1 / ^9.1.0 | Signed session cookie; API response headers; 10 req/min/IP on `auth/login` and `auth/accept-invite` (`global: false`, opt-in per route) |
| Passwords | `argon2` (argon2id, 19 MiB / t=2 / p=1) | ^0.41.1 | Password hashing and verification |
| DB driver | `pg` (node-postgres) | ^8.13.1 | Pool of 10; no ORM; `int8` and `numeric` type parsers set in `api/src/db.ts` |
| Validation | `zod` | ^3.24.1 | Env contract (`config.ts`) and every route's params/query/body |
| Logging | `pino` (via Fastify) | ^9.6.0 | Request logs with request ids; cookie / authorization / set-cookie redacted |
| API language / tooling | TypeScript, `tsx` | ^5.7.2, ^4.19.2 | `npm run build` (tsc), `npm run dev` (tsx watch), `npm test` (`tsx --test`) |
| SPA framework | React + React DOM | ^18.3.1 | UI |
| Routing | `react-router-dom` | ^6.28.0 | Client routes, incl. `/invite/:token` |
| Server state | `@tanstack/react-query` | ^5.62.0 | All API queries/mutations (`web/src/api/hooks.ts`) |
| Map | `maplibre-gl` | ^5.0.0 | Household points, base layers, filters. ~1 MB — `lazy()`-loaded behind `/map` and manually chunked |
| Web build | Vite (+ `@vitejs/plugin-react`) | ^5.4.11 | Dev server, production build to `/app/dist`, and an inline plugin that emits `sw.js` |
| Importer | Python (`python:3.12-slim`), non-root uid 10001 | 3.12 | One-shot CSV load |
| Importer driver | `psycopg[binary]` | >=3.2,<4 | The importer's only third-party dependency; everything else is stdlib |

Both images build multi-stage and run as non-root. The API image installs `curl` solely for its
`HEALTHCHECK`.

---

## 3. File structure

```
mc-canvass/
├── docker-compose.yml     five services: db, api, web (build-only), caddy, importer (profile "import")
├── Caddyfile              TLS + security headers + /api/* proxy + SPA fallback
├── Makefile               operator targets (up/down/logs/import/backup/restore/purge/psql/test)
├── .env.example           DOMAIN, POSTGRES_PASSWORD, SESSION_SECRET, ADMIN_*, BACKUP_PASSPHRASE
│
├── db/
│   └── schema.sql         the whole schema. Mounted into /docker-entrypoint-initdb.d/ and applied
│                          ONLY on the first boot of an empty pgdata volume. No migration runner yet.
│
├── importer/              one-shot loader: import.py (single file, stdlib + psycopg), requirements.txt,
│                          Dockerfile. Reads /data/*.csv read-only, writes household/voter/import_run.
│
├── api/
│   ├── src/
│   │   ├── server.ts      process entry: loadConfig → buildApp → listen, SIGINT/SIGTERM shutdown
│   │   ├── app.ts         builds the Fastify instance: plugins, error envelope, 404 handler,
│   │   │                  session hook, route registration under /api, bootstrapAdmin
│   │   ├── config.ts      zod env contract + the shared constants (SESSION_COOKIE, SESSION_DAYS,
│   │   │                  INVITE_DAYS, MIN_PASSWORD)
│   │   ├── db.ts          pg Pool factory and the q / one / withTx helpers
│   │   ├── auth/          session.ts (cookie ↔ session row, sliding expiry), guard.ts (the global
│   │   │                  onRequest hook + requireAuth / requireRole preHandlers), password.ts
│   │   │                  (argon2id, invite tokens), bootstrap.ts (first-boot admin)
│   │   ├── lib/           serialize.ts (THE role-based field allow-list — see §5), audit.ts,
│   │   │                  errors.ts (ApiError + badRequest/unauthorized/forbidden/… factories)
│   │   └── routes/        one Fastify plugin per endpoint group: auth, users, meta, households,
│   │                      search, streets, stats, audit, health. SQL lives in the route.
│   └── test/              api.test.ts — integration suite against a real, imported database
│
├── web/
│   ├── vite.config.ts     dev server (port + mkcert HTTPS + /api proxy), manual chunks, and the
│   │                      inline plugin that generates the app-shell service worker at build time
│   ├── src/
│   │   ├── App.tsx        the route table; role gates wrap /stats, /admin/users, /admin/audit
│   │   ├── auth.tsx       client-side RequireAuth / RequireRole — cosmetic only, never a data boundary
│   │   ├── api/           client.ts (the ONLY fetch wrapper), hooks.ts (every query/mutation),
│   │   │                  types.ts (mirrors API.md)
│   │   ├── pages/         one component per route (Login, Invite, Map, Stats, Users, Audit, Account)
│   │   ├── map/           MapView + style.ts (the whole MapLibre style), palette.ts (colours shared
│   │   │                  with the legend and stats), filters, search box, household card, legal list
│   │   └── components/    Shell (nav), Bars, shared ui primitives
│   ├── public/            manifest.webmanifest, icons/, self-hosted map glyph fonts/
│   └── tools/             make_glyphs.py, make_icons.py, e2e.py (Playwright smoke run)
│
├── data/                  mc_boundary.json (tracked); voters_final.csv + households.csv (git-ignored)
└── backups/               encrypted dumps from `make backup` (git-ignored)
```

---

## 4. Data model

All of it is in [`../db/schema.sql`](../db/schema.sql), applied once on the first boot of the `db`
container. There is no migration runner — changing the schema on a live stack means writing the
migration by hand.

```
app_user ──< session                     (ON DELETE CASCADE)
app_user ──< audit_log                    (user_id nullable: failed logins have no user)
app_user ──< turf.created_by, assignment.user_id, contact.user_id

import_run ──< household ──< voter        (voter.household_id ON DELETE CASCADE)
                   │             │
                   └─ turf_household      contact.voter_id ─┘  (ON DELETE SET NULL)
                   └─< contact

turf ──< turf_household >── household
turf ──< assignment >── app_user          (UNIQUE (turf_id, user_id))

VIEW household_status  = household ⟕ latest contact for that door
VIEW voter_status      = voter     ⟕ latest contact for that voter
```

**Users and sessions.** `app_user` (uuid pk, `citext` email unique, `user_role` enum
`admin|organizer|volunteer`, `password_hash` NULL until an invite is accepted, `invite_token` unique +
`invite_expires`, `active`, `last_login_at`). `session` rows are the sessions themselves — the cookie
value *is* `session.id` — with `expires_at`, `user_agent` and `ip`, cascading on user delete.

**Imports.** `import_run` records `source_label`, `voters_sha256`, `households_sha256`, row counts and
`finished_at`. The importer is idempotent on identical hashes; both `household` and `voter` carry
`import_run_id`, so every row is traceable to the file it came from.

**Households and voters.** `household.id` is the pipeline id (`H-KOMOKA-00123`, `H-LEGAL-0007`), which is
why it is `text` and not a surrogate key. It carries ward/community/postal/locality, the parsed civic
address (`civic_num`, `street`, `street_type`, `street_dir`, `unit`), `lat`/`lon`, geocoding provenance
(`addr_match`, `record_quality`), the `is_legal` / `is_institution` flags, the denormalized counts
(`n_voters`, `n_nonresident`, `n_po_box`) and the walking-order keys (`street_sort`, `num_sort`).
`voter` holds split name fields plus `name_raw` for traceability, `resident_class`, the mailing fields,
and `natural_key` (UNIQUE) — the stable identity used to match voters across re-imports. Indexes are
tuned for the Phase 1 read paths: ward, community, `(lat, lon)`, `(street_sort, num_sort)`, and GIN
trigram indexes on `household.address` and `voter.full_name` for `/api/search`.

**Why lat/lon and not PostGIS geometry.** The production image *is* `postgis/postgis:16-3.4`, but the
Phase 1 schema deliberately stores two `double precision` columns instead of a `geometry` point, so the
same `schema.sql` also runs on a bare PostgreSQL 16 in development and CI. Nothing in Phase 1 needs
spatial operators: the map query is a plain bbox `BETWEEN` on indexed columns, and the municipal boundary
is a static GeoJSON file served by `/api/meta`. Phase 2 (turfs, spatial joins) is where
`CREATE EXTENSION postgis` and a geometry column arrive, via a hand-written `migrations/002`.

**Phase 2 tables that exist but are unused.** `turf` (GeoJSON polygon in a `jsonb` column for now),
`turf_household` (with `walk_order`), `assignment` (turf ↔ user, `UNIQUE (turf_id, user_id)`) and
`contact` (append-only canvass events: `contact_result` enum, 1–5 `support`, issue tags, flags, note,
plus a UNIQUE `client_id` as the idempotency key for the future offline queue). They are created now so
Phase 1 endpoints can join to them and return `null`/zero canvass fields without a migration — which is
exactly what `GET /api/households/:id` and `/api/stats/overview` do today.

**Views.** `household_status` and `voter_status` are `LEFT JOIN LATERAL … ORDER BY at DESC LIMIT 1` over
`contact`, giving the latest door-level result and the latest voter-level support. In Phase 1 they return
all-NULL because `contact` is empty. Worth knowing: no Phase 1 route actually selects from these views —
`routes/households.ts` inlines the identical lateral subquery (partly so the volunteer path can drop the
join entirely) and `routes/stats.ts` aggregates `contact` directly. The views are the documented shape
for Phase 2.

**Audit.** `audit_log` (bigserial, `at`, nullable `user_id`, `action`, `target`, `detail` jsonb, `ip`)
is append-only and indexed on `(user_id, at DESC)`. Every read of personal data writes a row here; that
is a Municipal Elections Act requirement, not a nice-to-have.

---

## 5. API integration

### Transport

The SPA and the API are **same-origin**. `web/src/api/client.ts` is the only place that calls `fetch`:
it prefixes every path with `/api`, sends `credentials: 'same-origin'`, and never sets a base URL or an
`Authorization` header. In production Caddy routes `/api/*` to `api:3000`; in development Vite proxies
`/api` to the local API. There is no CORS configuration anywhere because there is no cross-origin case.

### Session cookie

Login sets `canvass_sid` — the `session.id` UUID, signed by `@fastify/cookie` with `SESSION_SECRET`:

| Attribute | Value | Set in |
|---|---|---|
| Name | `canvass_sid` | `api/src/config.ts` (`SESSION_COOKIE`) |
| `HttpOnly` | true | `setSessionCookie`, `api/src/auth/session.ts` |
| `Secure` | `config.COOKIE_SECURE` (default `true`; `false` only for plain-HTTP dev) | same |
| `SameSite` | `Lax` | same |
| `Path` | `/` | same |
| Lifetime | 30 days, **sliding** | `SESSION_DAYS`; bumped in `loadSession` |

The sliding expiry is cheap by construction: `loadSession` pushes `expires_at` back to 30 days only when
fewer than 29 remain, so at most one `UPDATE` per session per day, fire-and-forget. Server-side session
rows mean revocation is real — deactivating a user or changing a password deletes rows
(`destroyOtherSessions`) and every other device is logged out on its next request.

### Error envelope

Every failure is `{ "error": { "code": "...", "message": "..." } }`, produced in one place —
`app.setErrorHandler` in `api/src/app.ts`:

- `ApiError` (from `api/src/lib/errors.ts`) → its own status and code. Throw these; never reply with an
  ad-hoc error shape.
- `ZodError` → `400 validation_error` with the joined issue paths.
- Anything ≥ 500 → logged with the request id, returned as `500 internal_error` with a fixed message.
- The 404 handler and the rate limiter's `errorResponseBuilder` (`429 rate_limited`) feed the same shape.

The client mirrors it: `client.ts` parses `error.code` / `error.message` into its own `ApiError`
(`{ status, code, message }`), falls back to `http_<status>` when a body is missing, and notifies
`onUnauthorized` listeners on any 401 so the app can drop to `/login`.

### Roles

`admin > organizer > volunteer`, ranked once in `serialize.ts` (`roleAtLeast`) and mirrored — cosmetically
— in `web/src/auth.tsx`. The client gates are navigation sugar; **the API is the boundary**.

Routes opt in to a guard via a preHandler: `requireAuth` (any signed-in user) or
`requireRole('organizer' | 'admin')`. Endpoints with no guard: `POST /api/auth/login`,
`POST /api/auth/accept-invite`, `POST /api/auth/logout` and `GET /api/health`.

### `api/src/lib/serialize.ts` — the single enforcement point

Every voter, household and map-point row that leaves the API passes through one of
`serializeVoter` / `serializeHousehold` / `serializePointProps`. These are **explicit allow-lists**: they
build a new object by picking keys, they never delete keys from a row. That is deliberate — a column
accidentally added to a SQL projection cannot leak, because nothing copies unknown keys through.

Fields a volunteer **never** receives:

| Field | Source | Stripped by |
|---|---|---|
| `mailing_address` | `voter` | `serializeVoter` |
| `mail_city` | `voter` | `serializeVoter` |
| `mail_postal` | `voter` | `serializeVoter` |
| `resident_class` | `voter` | `serializeVoter` |
| `n_nonresident` | `household` | `serializeHousehold` |
| `n_po_box` | `household` | `serializeHousehold` |
| `nonres` (= `n_nonresident`) | map point props | `serializePointProps` |
| `q` (= `record_quality`) | map point props | `serializePointProps` |
| `status` (= last contact result) | map point props | `serializePointProps` |

Volunteers also get no municipality-wide search: `/api/search`, `/api/streets`, `/api/stats/overview`,
`/api/households/legal` and `/api/households/:id` are all organizer-or-above. In Phase 1 that leaves a
volunteer with the map's anonymous household points and nothing else; Phase 2 scopes the door screen to
their assigned turfs.

`GET /api/households/points` goes one step further than stripping output: for volunteers the route skips
the per-row `contact` lateral join entirely, so the data is never fetched in the first place.

**When you add a personal-data field**, add it to the right role branch in `serialize.ts`, update
`API.md`, and extend the restricted-key assertions in `api/test/api.test.ts` — which asserts that
volunteer responses carry none of the six fields above.

### Endpoint groups

Summary only — [`../API.md`](../API.md) is the contract.

| Group | Prefix | Minimum role | Notes |
|---|---|---|---|
| Health | `/api/health` | none | `{ ok, db, import_id }`; the compose healthcheck. 503 when the DB is down |
| Auth | `/api/auth/*` | none / any | `login`, `logout`, `me`, `accept-invite`, `change-password`. `login` and `accept-invite` are rate-limited 10/min/IP |
| Users | `/api/users/*` | admin | list, invite, reinvite, patch. Invite tokens are stored sha256-hashed; the raw token appears only in `invite_url` |
| Reference | `/api/meta` | any | wards, communities, latest import, and the municipal boundary polygon read once at boot from `BOUNDARY_PATH` |
| Households | `/api/households/*` | `points`: any · `legal`, `:id`: organizer | `points` returns `application/geo+json`, all matching households in one payload, `Cache-Control: private, max-age=60` |
| Search | `/api/search` | organizer | trigram similarity over `voter.full_name` and `household.address`. Audited |
| Streets | `/api/streets` | organizer | street picker; the future turf builder's input |
| Stats | `/api/stats/overview` | organizer | totals, per-ward, per-community, quality, household size; canvass numbers are zero in Phase 1 |
| Audit | `/api/audit` | admin | reverse-chronological, keyset-paged on `before=<id>` |

### Client-side caching and the service worker

TanStack Query holds API responses in memory only. The service worker generated by the inline Vite plugin
precaches the app shell (index.html, the hashed bundles, icons, map glyph fonts) and **returns early for
any URL under `/api/`**, so no voter data is ever written to the browser's Cache Storage. Cross-origin
requests (basemap tiles) are left to the browser cache. Navigations are network-first with the cached
shell as the offline fallback.

---

## 6. Request lifecycle — `GET /api/households/H-KOMOKA-00123`

1. **Browser.** `useHousehold(id)` (TanStack Query) → `api.get('/households/H-KOMOKA-00123')` →
   `fetch('/api/households/…', { credentials: 'same-origin' })`. The `canvass_sid` cookie rides along
   automatically; nothing else authenticates the call.
2. **Caddy.** The request matches `handle /api/*` and is reverse-proxied to `api:3000` over the compose
   network. Caddy terminates TLS and adds the security headers; `X-Forwarded-For` is why the API runs with
   `TRUST_PROXY=1`, so `req.ip` is the real client address for the rate limiter and the audit row.
3. **Fastify `onRequest` — session.** The global hook registered by `registerSessionHook`
   (`api/src/auth/guard.ts`) runs `loadSession`: read the cookie, `unsignCookie` it, sanity-check the UUID
   shape, then one indexed query joining `session` to `app_user` filtered on `expires_at > now()`.
   Inactive users resolve to `null`. If more than a day has elapsed, an unawaited `UPDATE` slides
   `expires_at` back out to 30 days. The result lands on `req.session` — one query per request, whatever
   the route.
4. **`preHandler` — role.** The route is registered with `requireRole('organizer')`. No session →
   `unauthorized()` (401). A volunteer → `forbidden('this route requires the organizer role')` (403).
   Both are `ApiError`s and are thrown, not replied.
5. **Validation.** `idParams.parse(req.params)` — a zod regex (`/^H-[A-Z]+-\d{1,8}$/`) on the household id.
   A bad id becomes `400 validation_error` via the shared error handler.
6. **SQL.** Three statements: the household row (`HOUSEHOLD_COLS`), then — in parallel via
   `Promise.all` — the voters with their latest support (`LEFT JOIN LATERAL` over `contact`, ordered by
   last name, first name) and the door's latest contact joined to `app_user` for `last_user_name`.
   Parameterized throughout; no ORM. A missing household throws `notFound()` (404) before any audit write.
7. **Audit.** `await audit(app.db, req.log, { userId, action: 'view_household', target: id, ip: req.ip })`
   inserts into `audit_log`. It is awaited so the entry exists before the response goes out, but a failed
   audit write is logged at error level and never becomes a 500 — the read still succeeds, and ops are
   expected to watch that log.
8. **Serialize.** `serializeHousehold(hh, role)`, `voters.map(v => serializeVoter(v, role))`, and a
   `status` object that defaults to `{ last_result: null, last_contact_at: null, last_user_name: null }`
   when the door has never been contacted. Only allow-listed keys reach the response.
9. **Response.** Fastify serializes the object to JSON; Caddy compresses it. On the way back, a 401 would
   fire the client's `onUnauthorized` listeners and bounce the user to `/login`; anything else surfaces as
   an `ApiError` for the page to render.

`GET /api/households/points` follows the same path with two differences: the guard is `requireAuth`
(every role), and the response body is assembled as a hand-rolled JSON string rather than an object
graph — measured at ~45 ms end to end for the full ~7.1k-point set, versus ~78 ms in the database alone
for the `json_agg` equivalent.

---

## 7. Ports and URLs

**Development** (registered in `~/.claude/PORTS.md`; verify with `lsof -i :<port>` before starting):

| Service | Port | Notes |
|---|---|---|
| Web (Vite dev server) | **3030** | HTTPS via the shared mkcert cert at `~/Code/.traefik/certs/{cert,key}.pem`; `strictPort`, `host: true`. Falls back to plain HTTP if the cert is missing. Proxies `/api` → `http://localhost:3130` |
| API (`npm run dev`) | **3130** | Plain HTTP; reached only through the Vite proxy. Set `PORT=3130` |
| Postgres | **5443** | `postgresql://canvass:canvass@localhost:5443/canvass`, schema applied with `psql -f db/schema.sql` |
| `vite preview` | 4173 | Same HTTPS cert and `/api` proxy; used by `web/tools/e2e.py` |

Dev URL: **https://dev.ecoworks.ca:3030** — never `localhost` or a raw LAN IP. Because the dev server
serves TLS, the session cookie keeps its `Secure` flag in development too (no `COOKIE_SECURE=false`
needed), which is how production behaves.

**Production:** **https://canvass.sean-hunt.com**, Caddy on 80/443 with an automatic Let's Encrypt
certificate for `$DOMAIN`. Port 80 must stay open for the ACME challenge and the HTTP→HTTPS redirect.
The API listens on 3000 inside the compose network and is never published.
