# Canvass API contract — Phase 1

Base path `/api`. JSON in/out. Auth is a session cookie (`canvass_sid`, HttpOnly, Secure, SameSite=Lax) set by `/api/auth/login`.
Every route except `auth/login`, `auth/accept-invite`, `health` requires a session. Roles: `admin` > `organizer` > `volunteer`.
Errors: `{ "error": { "code": "string", "message": "string" } }` with 400 / 401 / 403 / 404 / 409 / 500.

Rule for volunteers: they never receive `mailing_address`, `mail_city`, `mail_postal`, `resident_class`, `n_nonresident`,
`n_po_box`, or any search across the whole municipality. In Phase 1 (no turfs yet) a volunteer can log in and see the
map with household points but no names or addresses; the household card returns 403 for volunteers until Phase 2 scopes it by turf.

## Auth
- `POST /api/auth/login` `{ email, password }` → `200 { user }` and sets cookie. `401` on bad credentials. Rate-limited (10/min/IP). Writes audit `login`.
- `POST /api/auth/logout` → `204`. Clears cookie. Audit `logout`.
- `GET  /api/auth/me` → `{ user }` where `user = { id, email, name, role }`.
- `POST /api/auth/accept-invite` `{ token, name, password }` → `200 { user }` + cookie. Password ≥ 10 chars. `410` if expired/used.
- `POST /api/auth/change-password` `{ current, next }` → `204`.

## Users (admin)
- `GET  /api/users` → `{ users: [{ id, email, name, role, active, created_at, last_login_at, invite_pending }] }`
- `POST /api/users/invite` `{ email, name, role }` → `201 { user, invite_url }` — invite_url is `https://$DOMAIN/invite/<token>`; the admin sends it themselves (no email service in Phase 1). Token valid 7 days. Audit `invite`.
- `POST /api/users/:id/reinvite` → `200 { invite_url }`
- `PATCH /api/users/:id` `{ role?, active?, name? }` → `{ user }`. Cannot deactivate the last admin.

## Reference data
- `GET /api/meta` → `{ wards: [{ ward, n_households, n_voters }], communities: [{ community, n_households, n_voters }], import: { id, source_label, finished_at, n_voters, n_households }, boundary: GeoJSON Polygon }`
  (boundary served from `data/mc_boundary.json`.)

## Households
- `GET /api/households/points?ward=01,02&community=KOMOKA&quality=good,approx&bbox=minLon,minLat,maxLon,maxLat`
  → GeoJSON FeatureCollection of ALL matching households with civic coords (legal ones excluded — they have no point).
  Feature properties, **every role**: `{ id, ward, community, n, inst }` (`n` = n_voters, `inst` = is_institution).
  Organizer/admin additionally get: `{ nonres: n_nonresident, q: record_quality, status: last_result | null }`.
  Bounded to ~7.1k features; no pagination. Cache-Control: private, max-age=60.
- `GET /api/households/:id` → household card (organizer/admin; volunteer → 403 in Phase 1):
  ```
  { id, ward, community, postal, locality, address, property_address_raw, civic_num, street, street_type, street_dir, unit,
    lat, lon, addr_match, record_quality, is_legal, is_institution, n_voters,
    voters: [{ id, display_name, full_name, first_name, middle_names, last_name, suffix, resident_class, mail_kind,
               mail_differs_real, mailing_address, mail_city, mail_postal, last_support, last_result, last_contact_at }],
    status: { last_result, last_contact_at, last_user_name } }
  ```
  Audit `view_household`.
- `GET /api/households/legal?ward=` → `{ households: [...] }` the concession/lot rows (organizer/admin) so they are listable even though unmapped.

## Search (organizer/admin)
- `GET /api/search?q=adams&limit=25` → `{ voters: [{ id, display_name, household_id, address, community, ward }], households: [{ id, address, community, ward, n_voters }] }`
  Trigram similarity on `voter.full_name` and `household.address`; also matches "123 King" style (number + street prefix). Audit `search` with `{ q }`.

## Streets (organizer/admin) — used by the map's street picker and the future turf builder
- `GET /api/streets?ward=&community=` → `{ streets: [{ street_sort, label, ward, community, n_households, n_voters, min_num, max_num }] }`

## Stats (organizer/admin)
- `GET /api/stats/overview` →
  ```
  { totals: { households, voters, residents, nonresidents, institutions, legal, po_box_only },
    by_ward: [{ ward, households, voters, nonresidents, avg_voters_per_door }],
    by_community: [{ community, households, voters, nonresidents }],
    quality: { good, approx, legal, check },
    household_size: [{ size, households }],           // 1,2,3,4,5,6+ 
    canvass: { contacted_households, contacts_today, contacts_7d, support_hist: [n1..n5] }   // zeros in Phase 1
  }
  ```

## Audit (admin)
- `GET /api/audit?limit=200&before=<id>` → `{ entries: [...] }`

## Health
- `GET /api/health` → `{ ok: true, db: true, import_id }` (no auth; used by compose healthcheck).
  Returns `503 { ok: false, db: false, import_id: null }` when the database is unreachable — note this is
  the plain shape, not the `{ error: ... }` envelope, because the container healthcheck only reads the status code.

## Conventions
- Fastify 4 + TypeScript, `zod` for input validation, `pg` (node-postgres) with a pool, no ORM.
- Sessions in `session` table; cookie value is the session id; 30-day sliding expiry.
- Passwords: `argon2id` via `argon2` package.
- All `SELECT`s that return voter rows go through one `serializeVoter(row, role)` function that strips organizer-only fields for volunteers — this is the single enforcement point.
- Env: `DATABASE_URL`, `SESSION_SECRET` (for cookie signing), `DOMAIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (used ONLY on first boot to create the initial admin if no users exist), `PORT` (default 3000), `HOST` (default `0.0.0.0`), `TRUST_PROXY=1`.
- Logging: pino, request ids; never log request bodies on auth routes.

## Implementation notes (Phase 1 backend — clarifications, no shape changes)
- `stats.household_size[].size` is a **string label**: `"1"`, `"2"`, `"3"`, `"4"`, `"5"`, `"6+"`.
- `stats.totals.nonresidents` / `by_ward[].nonresidents` / `by_community[].nonresidents` count voters with
  `resident_class = 'non-resident'` (337). `household.n_nonresident` (used by `points.nonres`) is the pipeline's
  count and also includes the 4 `unknown` voters (341 in total). `totals.po_box_only` = households where every
  voter's mailing address is a PO box (`n_po_box >= n_voters`).
- `GET /api/households/legal` rows are the household card fields (no `voters` array) plus `voter_names`
  ("A; B; C") for listing.
- `GET /api/households/:id` `status` is always present; `{ last_result: null, last_contact_at: null, last_user_name: null }`
  when the door has never been contacted. `voters[]` are ordered by last name, first name.
- `GET /api/households/points` is served as `application/geo+json`; coordinates are rounded to 6 decimals.
  Volunteers' features carry only `{ id, ward, community, n, inst }`; the contact lookup is skipped for them.
- `GET /api/audit` also accepts `user_id=<uuid>` and `action=<name>` filters; entries are
  `{ id, at, user_id, user_email, user_name, action, target, detail, ip }`. Extra audited actions:
  `login_failed`, `accept_invite`, `change_password`, `reinvite`, `update_user`.
- `POST /api/users/:id/reinvite` also works for a user who already has a password (acts as an admin-driven
  password reset: accepting the new invite sets a new password and drops old sessions).
- Invite tokens are stored hashed (sha256) in `app_user.invite_token`; the raw token appears only in `invite_url`.
- `429 { error: { code: "rate_limited" } }` on `auth/login` and `auth/accept-invite` (10/min/IP).
- Env additions: `COOKIE_SECURE` (default `true`; `false` for plain-http local dev), `BOUNDARY_PATH`, `LOG_LEVEL`, `HOST`.
- Duplicate list entries (same name + property twice) get `natural_key` suffixed `#2` so the UNIQUE constraint holds
  and every CSV row is kept.
