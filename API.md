# Canvass API contract — Phases 1–2

Base path `/api`. JSON in/out. Auth is a session cookie (`canvass_sid`, HttpOnly, Secure, SameSite=Lax) set by `/api/auth/login`.
Every route except `auth/login`, `auth/accept-invite`, `health` requires a session. Roles: `admin` > `organizer` > `volunteer`.
Errors: `{ "error": { "code": "string", "message": "string" } }` with 400 / 401 / 403 / 404 / 409 / 500.

Rule for volunteers: they never receive `mailing_address`, `mail_city`, `mail_postal`, `resident_class`, `n_nonresident`,
`n_po_box`, or any search across the whole municipality. In Phase 1 (no turfs yet) a volunteer could log in and see the
map with household points but no names or addresses at all.

**Phase 2 widens that by exactly one rule: a volunteer may read and write the doors of the turfs assigned to them.**
Inside an assigned turf they get voter *names* (they need them at the door) and may record contacts; outside it every
household id still answers `403 { error: { code: "not_your_turf" } }`. The stripped fields above stay stripped
everywhere, including inside their own turf. Organizers and admins are unscoped. The enforcement lives in
`api/src/lib/scope.ts` (who may see which door) and `api/src/lib/serialize.ts` (which fields leave the API).

## Auth
- `POST /api/auth/login` `{ email, password }` → `200 { user }` and sets cookie. `401` on bad credentials. Rate-limited (10/min/IP). Writes audit `login`.
- `POST /api/auth/logout` → `204`. Clears cookie. Audit `logout`.
- `GET  /api/auth/me` → `{ user }` where `user = { id, email, name, role }`.
- `POST /api/auth/accept-invite` `{ token, name, password }` → `200 { user }` + cookie. Password ≥ 10 chars. `410` if expired/used.
- `POST /api/auth/change-password` `{ current, next }` → `204`.

## Users
- `GET  /api/users` — **organizer/admin** (organizers need it to fill the "assign this turf to…" picker).
  - admin → `{ users: [{ id, email, name, role, active, created_at, last_login_at, invite_pending }] }`
  - organizer → `{ users: [{ id, name, role, active }] }` — no email, no login times, no invite state.
  The projection is `serializeUserListRow(row, viewer)` in `lib/serialize.ts`, not an inline SELECT list.
  Volunteers → `403`. Every other route in this section stays admin-only.
- `POST /api/users/invite` (admin) `{ email, name, role }` → `201 { user, invite_url }` — invite_url is `https://$DOMAIN/invite/<token>`; the admin sends it themselves (no email service in Phase 1). Token valid 7 days. Audit `invite`.
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
  Volunteers additionally get `{ status: last_result | null }` **only on the doors inside a turf assigned to them**
  (so they can colour their own turf); every other feature keeps the five anonymous keys and no `status` key at all.
  Bounded to ~7.1k features; no pagination. Cache-Control: private, max-age=60.
- `GET /api/households/:id` → household card (organizer/admin: any door; volunteer: only a door inside one of their
  assigned turfs, otherwise `403 not_your_turf` — the scope is checked before the row is loaded, so an out-of-turf
  volunteer never learns whether the id exists):
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

## Turfs (organizer/admin)
- `POST /api/turfs` `{ name, ward?, streets?: string[], polygon?: GeoJSON Polygon }` → `201 { turf }`.
  Exactly one of `streets` or `polygon` (400 otherwise). `streets` are `street_sort` keys from `GET /api/streets`
  (upper-cased for you); `polygon` is a GeoJSON Polygon, rings of `[lon, lat]`, ≥ 4 positions, holes allowed.
  **`ward` is a label stored on the turf, never a filter on the selection**: `street_sort` is not unique per ward
  (a rural road that crosses a ward line is several rows in `GET /api/streets`), and a turf that stops halfway down
  a road at an invisible boundary is worse to walk than one that takes the whole road — this also keeps the street
  picker's "n households" preview honest. The same holds for `polygon`: the drawn geometry is the selection.
  `turf_household` is materialised in the same transaction, with
  `walk_order = row_number() over (order by street_sort, num_sort, id)` so doors come out in walking order.
  Audit `create_turf` with `{ name, by: "streets" | "polygon", n_households }`.
- `GET /api/turfs?archived=true` → `{ turfs: [{ id, name, ward, archived, created_at, created_by_name, n_households,
  n_voters, contacted, streets: string[], assignees: [{ id, user_id, name, status, due_date }] }] }`.
  `contacted` = doors in the turf with at least one `contact` row. `streets` is the distinct `street_sort` of the
  turf's households (whatever way the turf was built) so the builder can mark streets that already belong to a turf
  and avoid silent overlaps. **Archived turfs are omitted unless `archived=true`** (`true`/`1` include them;
  absent, `false` or `0` do not) — a finished walk must stop claiming its streets in the builder's overlap check.
  Unarchived first, then newest first.
- `GET /api/turfs/:id` → `{ turf }` — the same object plus `polygon` (the stored GeoJSON, `null` for a street turf).
  `404` if unknown.
- `PATCH /api/turfs/:id` `{ name?, archived? }` → `{ turf }`. Audit `update_turf`.
- `DELETE /api/turfs/:id` → `204`; `404` if unknown. `turf_household` and `assignment` cascade; existing contacts are
  kept (their `turf_id` becomes NULL). Audit `delete_turf`.
- `POST /api/turfs/:id/assign` `{ user_id, due_date? }` → `201 { assignment }` where
  `assignment = { id, turf_id, user_id, user_name, status, assigned_at, due_date }`.
  **Idempotent** on the `(turf_id, user_id)` unique constraint: re-assigning returns the row that is already there
  (still `201`, never a `409`/`500`), and only a real insert writes the `assign_turf` audit row.
  `404` for an unknown turf or an unknown/inactive user. `due_date` is `YYYY-MM-DD`.
- `DELETE /api/turfs/:id/assign/:user_id` → `204`, idempotent (deleting a non-existent assignment is still `204`).
  Audit `unassign_turf` when a row was actually removed.

## Assignments
- `GET /api/assignments/mine` — **any signed-in role**, returns the caller's own assignments (archived turfs omitted) →
  `{ assignments: [{ id, status, due_date, assigned_at, turf: { id, name, ward }, n_households, contacted }] }`
- `PATCH /api/assignments/:id` `{ status }` where status ∈ `open` | `in_progress` | `done` → `{ assignment }`.
  A volunteer may patch **only their own** assignment (`403 not_your_assignment`); organizer/admin may patch any.
  `404` if unknown. Audit `update_assignment`.

## Door screen
- `GET /api/turfs/:id/doors` → `{ turf, doors: [...] }`, ordered by `walk_order` (nulls last, then id):
  ```
  { household_id, address, community, ward, lat, lon, n_voters, walk_order,
    last_result, last_contact_at,
    voters: [ ... same projection as the household card, serialized by role ... ] }
  ```
  Organizer/admin: any turf. **Volunteer: only a turf they are assigned to, else `403 not_your_turf`.**
  `turf` is the `GET /api/turfs/:id` object (including `polygon` and `streets`) so the screen can draw the outline —
  but without `assignees`: a volunteer has no business knowing who else is on the turf.
  Volunteers get voter names here — that is the documented Phase 2 intent (prompt_plan.md "Open decisions":
  *names — needed at the door — but no mailing addresses or non-resident details*) — and still never
  `mailing_address`, `mail_city`, `mail_postal` or `resident_class`.
  Audit: **one** `view_turf_doors` entry per call with `{ n_doors }`, not one per door.

## Contacts
- `POST /api/contacts` → `201 { contacts, contact }`
  ```
  { household_id, voter_id?, voter_ids?, turf_id?, result, support?, supports?, issues?, wants_sign?,
    wants_volunteer?, needs_ride?, follow_up?, note?, client_id? }
  ```
  `result` ∈ `not_home` | `spoke` | `refused` | `moved` | `deceased` | `do_not_knock` | `inaccessible` |
  `left_literature`. `support` 1–5 (only when given). `issues` ≤ 20 tags of ≤ 40 chars. `note` ≤ 2000 chars.
  Unknown household → `404`.
  Every optional field also accepts an explicit `null` (a serialized door form sends `null` for the boxes nobody
  ticked); `null` and absent mean the same thing and both fall back to the column default —
  `issues: []`, the four flags `false`, everything else NULL.

  **More than one person at a door.** `voter_ids` is a list of ≤ 12 voter ids (`400 too_many_voters` beyond that);
  `voter_id` is the one-element form and is merged into it, so an existing caller sending only `voter_id` keeps
  working unchanged. Every named voter must belong to `household_id` (`400 voter_not_in_household`, message names
  the offending ids). **One `contact` row is written per named voter, all in one transaction**, sharing the
  door-level fields (`result`, `turf_id`, `issues`, the four flags, `note`). That is not a join table on purpose:
  `voter_status` already takes the latest `contact` row per voter, so per-person rows are what lets two people at
  one door hold different support levels — the common case, not an edge case. With no voter named, behaviour is
  exactly as before: a single door-level row with `voter_id` NULL.
  `support` applies to everyone named; `supports` is `{ "<voter_id>": 1..5 }` for per-person values and wins over
  `support` for the voters it names. A key in `supports` that is not among the named voters is
  `400 support_voter_not_named` (silently dropping it would show up later as a wrong canvass number).

  **Authorisation:** a volunteer may only record a contact for a household inside one of their assigned turfs
  (`403 not_your_turf`); organizer/admin may record anywhere.

  **Idempotency:** `client_id` is UNIQUE on `contact`, so N rows cannot all carry the submitted key. When voters
  are named, the stored key of each row is derived deterministically as **`<client_id>:<voter_id>`**; with nobody
  named the single door-level row stores `client_id` verbatim, unchanged from before. A retry from a phone that
  lost signal therefore re-derives the same keys and every row collapses onto the row it already wrote
  (`ON CONFLICT (client_id) DO NOTHING` + re-select of the whole set, in one transaction). The response is `200`
  when nothing new was inserted, `201` when at least one row was. The stored rows win; a replay with a changed
  body does not update anything. Contacts stay append-only: a correction is a new row, never an UPDATE.
  Note that the `client_id` echoed back is the **stored** (derived) key, not the submitted one.

  Audit `contact` with `{ result, household_id, voter_id }` — **one entry per row actually inserted** (each names a
  different person on the list), and never on an idempotent replay.

  Response: `contacts` is the array of rows, in the order the voters were named.
  `contact = contacts[0]` is **also** returned — the pre-multi-voter shape, kept populated so the existing web
  client does not break the moment this deploys. It is transitional: new clients should read `contacts`, and
  `contact` will be dropped once the web app has moved over.
  Each row is `{ id, household_id, voter_id, turf_id, at, client_id, result, support, issues, wants_sign,
  wants_volunteer, needs_ride, follow_up, note, user_id, user_name }`.
- `GET /api/contacts?household_id=<id>&limit=50` (1–200, default 50) →
  `{ contacts: [{ id, at, user_name, result, support, issues, wants_sign, wants_volunteer, needs_ride, follow_up,
  note, voter_id, voter_name }] }`, newest first. Volunteers: only households in their turfs (`403` otherwise).
- `GET /api/follow-ups?limit=200` (organizer/admin) → `{ follow_ups: [...] }` — doors whose **most recent** contact has
  `follow_up = true`, newest first:
  `{ household_id, address, ward, community, lat, lon, contact_id, last_contact_at, last_result, last_support,
  issues, wants_sign, wants_volunteer, needs_ride, note, user_id, user_name, voter_id, voter_name }`.
  Audit `view_follow_ups`.
- `GET /api/activity?days=14` (organizer/admin, 1–365) →
  `{ by_user: [{ user_id, name, contacts, doors, last_at }], by_day: [{ day, contacts }] }`.
  `doors` = distinct households contacted; `day` is a `YYYY-MM-DD` string in `America/Toronto` so an evening knock
  lands on that evening. Aggregates only — no audit row.

## Lawn signs
Placement is campaign logistics, not voter data, so **any signed-in role may place a sign and see the whole sign list**.
Ontario municipal sign by-laws require signs down within a set period after election day (Middlesex Centre: confirm the
window with the clerk), and a sign nobody can find is a fine — which is why the GPS fix and the photo exist. Signs also
go on road allowances, corners and business frontages that are not doors on the voters list, so `household_id` is
nullable and most fields are free text. The two exceptions to "not voter data" are documented below:
`GET /api/signs/requests` (which lists doors) and the photo bytes (which show somebody's house).

- `POST /api/signs` → `201 { sign }`, or `200 { sign }` on an idempotent replay
  ```
  { household_id?, lat, lon, accuracy_m?, label?, size?, note?, permission_by?, status?, requested_from?, client_id? }
  ```
  `lat`/`lon` are **required** and must be finite and inside Middlesex Centre's sanity box
  (lat 42.8–43.2, lon −81.7 to −81.1) — a fix that lands in Ottawa or on Null Island sends the pickup crew to the wrong
  concession while the real sign stays up, so it is refused with `400 { code: "coordinate_out_of_range" }` and a message
  telling the volunteer to wait for a better lock. `accuracy_m` is the device's reported accuracy in metres.
  `status` ∈ `requested` | `placed` | `removed` | `missing` | `damaged`, default `placed`.
  `label` ≤ 200, `size` ≤ 40, `note` ≤ 2000, `permission_by` ≤ 200 chars; every optional field also accepts `null`.
  Unknown `household_id` → `404`; `requested_from` must be a known `contact` id (`400 contact_not_found`).
  **Stamps:** a placement (any status except `requested`) sets `placed_by` = caller and `placed_at` = now;
  `status: "requested"` sets `requested_at` instead and leaves the placement columns NULL, because a sign that has not
  been planted yet must not appear on the pickup list as if it had. Supplying `requested_from` also sets `requested_at`.
  **Idempotency:** identical to `POST /api/contacts` — when `client_id` is supplied and already exists the stored row
  comes back with `200` instead of a second insert (`ON CONFLICT (client_id) DO NOTHING` + re-select in one
  transaction). The volunteer standing in a field with one bar of signal can retry safely; the stored row wins and a
  replay is not audited again. Audit `place_sign` with `{ status, household_id, lat, lon }`.
  Response `sign = { id, household_id, address, ward, status, lat, lon, accuracy_m, label, size, note, permission_by,
  requested_at, requested_from, placed_by, placed_by_name, placed_at, removed_by, removed_by_name, removed_at,
  created_at, client_id, photo_count }`. `address` and `ward` are the joined household's and are `null` for a sign that
  is not at a door; both are already in the volunteer-visible `HouseholdPublic` projection, so a volunteer learns
  nothing here they could not already see.
- `GET /api/signs?status=&ward=&bbox=` → `{ signs: [...] }`, newest first, same `sign` object as above.
  `status` and `ward` are comma-separated lists; `bbox` is `minLon,minLat,maxLon,maxLat` and is parsed exactly like
  `GET /api/households/points` (`400` on a malformed or out-of-range box). A sign with no household has no ward, so
  filtering by `ward` necessarily drops road-allowance signs.
- `GET /api/signs/:id` → `{ sign: { ...sign, photos: [...] } }`; `404` if unknown.
  `photo = { id, sign_id, content_type, bytes, width, height, taken_by, taken_by_name, taken_at }`. The on-disk `path`
  is never serialized. `width`/`height` are `null` when the header could not be parsed.
- `PATCH /api/signs/:id` `{ status?, label?, size?, note? }` → `{ sign: { ...sign, photos } }`; `400` if the body is
  empty, `404` if unknown. Setting `status: "removed"` stamps `removed_by`/`removed_at`; moving it back off `removed`
  clears both, so a sign marked collected by mistake does not carry a removal date while it is still standing. Any
  status other than `requested` also fills `placed_by`/`placed_at` **if they are still NULL** (a `requested` sign being
  delivered), never overwriting the volunteer who actually planted it. Audit `update_sign` with the patch plus
  `from_status`.
- `DELETE /api/signs/:id` → `204`; `404` if unknown. **Organizer/admin only** — a sign recorded by mistake should be
  deletable, but the record of where a sign is standing is not a volunteer's to erase. `sign_photo` rows cascade and
  their files are unlinked. Audit `delete_sign` with `{ label, status, photos }`.
- `GET /api/signs/pickup` → `{ signs: [...] }` — the post-election retrieval worklist: every sign still `placed` or
  `damaged`.
  `{ id, status, ward, address, label, size, note, lat, lon, accuracy_m, placed_at, placed_by_name, photo_ids }`
  Ordered ward → `label` (falling back to `address`) → latitude, nulls last. That is a "work one ward, then drive up
  the concession" ordering, deliberately **not** a travelling-salesman solve: it is stable, explainable to the
  volunteer holding the list, and good enough to collect a few hundred signs in a weekend. Every field needed to find
  the sign in November is on the line, including `photo_ids` for `GET /api/signs/photo/:photoId`.
- `GET /api/signs/requests?limit=200` (1–500) → `{ requests: [...] }` — doors whose **most recent** contact set
  `wants_sign = true` and which have **no `sign` row yet**. This closes the loop from the door screen to sign delivery
  and is the reason `contact.wants_sign` exists; a door drops off the list the moment a sign is placed against it.
  `{ household_id, address, ward, community, lat, lon, contact_id, last_contact_at, last_result, note, user_id,
  user_name, voter_id, voter_name }`, newest first.
  Unlike the rest of `/api/signs` this **is** voter data, so it follows the ordinary rules: **volunteers see only doors
  inside their assigned turfs**, organizer/admin see all, and every call writes audit `view_sign_requests` with `{ n }`.

### Sign photos
- `POST /api/signs/:id/photo` — one `multipart/form-data` file part → `201 { photo }`. Any signed-in role.
  Accepts `image/jpeg`, `image/png`, `image/webp` only, **verified from the file's magic bytes**, not from the declared
  `Content-Type`; the sniffed type is what is stored and later served
  (`400 { code: "unsupported_image" }` otherwise). Max 8 MB (`413 { code: "file_too_large" }`), one file per request.
  `400 not_multipart` when the request is not multipart, `400 no_file` when the part is missing, `400 empty_file` for a
  zero-byte upload, `404` for an unknown sign.
  The client filename is discarded entirely: the file is written to `SIGN_PHOTO_DIR` as `<uuid>.<jpg|png|webp>`, where
  the uuid is also the `sign_photo.id`. `width`/`height` are read from the header when the API can parse it.
- `GET /api/signs/photo/:photoId` — streams the bytes. **Auth required**: a photo of a lawn sign is a photo of
  somebody's house, which makes it personal information however mundane it looks. Sets the stored content-type,
  `Content-Length`, `Content-Disposition: inline` and `Cache-Control: private`. Audit `view_sign_photo` with
  `{ sign_id }`. `404 photo_file_missing` when the row survived but the file did not (a half-restored volume).
- `DELETE /api/signs/photo/:photoId` → `204`. **Organizer/admin only**; removes the row and the file.
  Audit `delete_sign` with `{ photo_id, sign_id }`.

## Voter contacts — phone / email collected at the door
**This is not voters-list data, and that is the whole reason it is a separate table (`voter_contact`,
`db/migrations/002_voter_contact.sql`) rather than columns on `voter`.** The clerk's list carries no phone numbers
and no email addresses; everything here was given directly by the person at the door, for a purpose they were told
about. So it has different rules from the list:

- **Consent is per purpose**, not one "ok to contact" boolean — `consent_gotv` (a reminder to vote, around election
  day) and `consent_updates` (general campaign updates) are separate columns, because a single flag cannot answer
  "did they agree to *this*?". A value offered with neither is **refused** (`400 consent_required`): a number nobody
  agreed to us using is not something to keep.
- **Withdrawal is recorded, never deleted.** `PATCH { withdrawn: true }` stamps `withdrawn_at` and the row stays.
  A deleted row would simply be re-collected at the next canvass; the point is to remember that somebody asked us
  to stop. `DELETE` exists only for a genuine mistake (a wrong number typed) and is organizer/admin only.
- **It must never be merged back into an export of the voters list**, and it is destroyed by `make purge` with
  everything else after the election.
- Canada's Anti-Spam Legislation governs the messages this feeds, so recording *what* was agreed, *when* and *who*
  took it is what makes the consent defensible. Every read and every change of consent writes `audit_log`, and the
  audit `detail` deliberately never contains the value itself — `audit_log` would otherwise become a second,
  un-withdrawable copy of every number the campaign was ever given.

- `POST /api/voter-contacts` → `201 { voter_contact }` (or `200` on a re-offer, below)
  ```
  { household_id, voter_id?, channel, value, consent_gotv?, consent_updates?, consent_note?, contact_id? }
  ```
  `channel` ∈ `phone` | `email`. `voter_id` is optional — a number can belong to the house rather than to a named
  person — but when given it must belong to `household_id` (`400 voter_not_in_household`). `contact_id` optionally
  ties the value to the doorstep conversation it came out of and must be a contact at the same household
  (`400 contact_not_found`). `consent_note` ≤ 500 chars. Unknown household → `404`.
  **At least one of `consent_gotv` / `consent_updates` must be true**, else `400 consent_required`.
  **Normalisation** (the UNIQUE key is on the stored value, so the same number offered twice in two formats has to
  become one row): a phone is reduced to digits and stored as `+1XXXXXXXXXX` when it is a valid 10- or 11-digit
  North American number (area code and exchange must start 2–9); an explicitly international value (leading `+`,
  8–15 digits) is stored as `+<digits>`; anything else is `400 invalid_phone`. An email is trimmed, lower-cased and
  syntax-checked, else `400 invalid_email`.
  **Duplicate `(household_id, channel, value)` is not a conflict**: somebody re-offering their number is granting
  consent again. The existing row is updated — consent flags are OR-ed (a re-offer grants, it never silently
  revokes), `consent_note` / `contact_id` / `voter_id` fill in when supplied, `consented_at` and `collected_by` are
  refreshed — and returned with `200`. `withdrawn_at` is deliberately **not** cleared by a re-offer: a door-side
  re-offer must not quietly undo "please stop"; lifting it is an explicit `PATCH { withdrawn: false }`.
  **Authorisation:** volunteers only for households inside their assigned turfs (`403 not_your_turf`).
  Audit `collect_voter_contact` with `{ household_id, voter_id, channel, consent_gotv, consent_updates, re_offered }`.
- `GET /api/voter-contacts?household_id=<id>` → `{ voter_contacts: [...] }` — the door's details, ordered by
  channel then value. Volunteers: only households in their turfs (`403 not_your_turf`); they collected these and
  have to be able to see and correct a mistyped number. Audit `view_voter_contacts` with `{ n }`.
  Row = `{ id, household_id, voter_id, voter_name, channel, value, consent_gotv, consent_updates, consent_note,
  consented_at, collected_by, collected_by_name, contact_id, withdrawn_at, withdrawn_note, created_at }` — the
  consent state always travels with the value, so no caller holds the number without holding what it may be used for.
- `PATCH /api/voter-contacts/:id` `{ consent_gotv?, consent_updates?, withdrawn?, withdrawn_note? }` →
  `{ voter_contact }`. `withdrawn: true` stamps `withdrawn_at` (`coalesce`d, so a second request keeps the moment
  they first asked) and keeps the row; `withdrawn: false` lifts it and clears `withdrawn_note` with it. Any
  signed-in user may patch a row for a door in their scope — the person is standing there asking, and the volunteer
  must be able to act on it without finding an organizer. `404` if unknown, `403 not_your_turf` out of scope.
  Audit `withdraw_voter_contact` when `withdrawn: true`, otherwise `update_voter_contact`.
- `DELETE /api/voter-contacts/:id` → `204`. **Organizer/admin only**, for a genuine mistake such as a wrong number
  typed at the door. Somebody asking us to stop is a *withdrawal*, not a delete. `404` if unknown.
  Audit `delete_voter_contact`.
- `GET /api/voter-contacts/gotv?channel=&limit=1000` (1–5000) — **organizer/admin only**. The send list: rows with
  `consent_gotv` and `withdrawn_at IS NULL`, optionally one channel, ordered ward → address → value. This is the
  one thing here that would ever leave the system, so it is role-gated and **audited on every call**, empty result
  included, with `{ channel, n }` — who pulled the list and when is exactly what has to be answerable later.
  Row = `{ id, channel, value, voter_id, voter_name, household_id, address, ward, community, consent_note,
  consented_at }`; `consent_gotv`/`consented_at` ride along because whoever exports this is the person who has to
  answer "what did they agree to?".

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
  `login_failed`, `accept_invite`, `change_password`, `reinvite`, `update_user`. Phase 2 adds `create_turf`,
  `update_turf`, `delete_turf`, `assign_turf`, `unassign_turf`, `update_assignment`, `view_turf_doors`,
  `view_follow_ups`, `contact`. Lawn signs add `place_sign`, `update_sign`, `delete_sign`, `upload_sign_photo`,
  `view_sign_photo` and `view_sign_requests`. Doorstep phone/email adds `collect_voter_contact`,
  `view_voter_contacts`, `update_voter_contact`, `withdraw_voter_contact`, `delete_voter_contact` and
  `view_gotv_list`.
- `POST /api/users/:id/reinvite` also works for a user who already has a password (acts as an admin-driven
  password reset: accepting the new invite sets a new password and drops old sessions).
- Invite tokens are stored hashed (sha256) in `app_user.invite_token`; the raw token appears only in `invite_url`.
- `429 { error: { code: "rate_limited" } }` on `auth/login` and `auth/accept-invite` (10/min/IP).
- Env additions: `COOKIE_SECURE` (default `true`; `false` for plain-http local dev), `BOUNDARY_PATH`, `LOG_LEVEL`, `HOST`,
  `SIGN_PHOTO_DIR` (default `../data/sign-photos`, created on boot if absent).
- Duplicate list entries (same name + property twice) get `natural_key` suffixed `#2` so the UNIQUE constraint holds
  and every CSV row is kept.

## Implementation notes (Phase 2 backend)
- **No migration.** The Phase 1 schema already carries `turf`, `turf_household`, `assignment` and `contact`, and it has
  no PostGIS geometry column on purpose. Polygon turfs are therefore materialised with a bbox pre-filter in SQL plus a
  ray-casting point-in-polygon test in TypeScript (`api/src/lib/geo.ts`, unit-tested in `api/test/geo.test.ts`) over
  the ~7k rows — a few hundred microseconds, once, when the turf is saved.
- The `household_status` / `voter_status` views still exist and are still unused: every route inlines the equivalent
  `LEFT JOIN LATERAL (... ORDER BY at DESC LIMIT 1)` so the status lookup can be filtered or skipped per role.
- Volunteer scoping is two helpers in `api/src/lib/scope.ts` (`assertTurfAccess`, `assertHouseholdAccess`); on the
  7k-row points query the volunteer's set of doors is materialised once in a CTE instead of being tested per row.
- `GET /api/households/points` for a volunteer with no assignments is byte-for-byte the Phase 1 response.
- A turf whose `streets`/`polygon` match nothing is still created (`201`, `n_households: 0`).
- Rows in `turf_household` are not exclusive: the same door may sit in more than one turf.
- `assignment.due_date` and `activity.by_day[].day` are serialized as `YYYY-MM-DD` strings, never as timestamps.
- Tests: `api/test/api.test.ts` writes to the database it is pointed at, so it refuses to start unless
  `CANVASS_TEST_DESTRUCTIVE=1` is set **and** the target database is not `canvass`. It never truncates — it creates
  its own `<who>+<run id>@test.local` users and deletes exactly the rows it created (users, sessions, audit entries,
  turfs, assignments, contacts) by id in `after()`. Run it against a throwaway copy:
  `CANVASS_TEST_DESTRUCTIVE=1 TEST_DATABASE_URL=<...>/canvass_test npm test`.

## Implementation notes (lawn signs)
- **No migration to write.** `db/migrations/001_signs.sql` (tables `sign` and `sign_photo`, enum `sign_status`) is
  already applied; the API adds no DDL.
- Photos are files on disk under `SIGN_PHOTO_DIR`, not rows: they are large, never queried, and living in `data/`
  means `make purge` shreds them with the CSVs after the election. `data/sign-photos/` is in `.gitignore`.
  The directory is created on boot, so the operator only has to provide the volume.
- Magic-byte sniffing and the width/height readers live in `api/src/lib/images.ts` — no image dependency. A header the
  parsers do not understand yields `width: null, height: null` rather than an error; only the container check is fatal.
- `@fastify/multipart` is registered in `app.ts` (it is `fastify-plugin` wrapped, so it applies app-wide however it is
  registered) with `limits: { fileSize: 8 MB, files: 1 }`. The photo endpoint is the only multipart route.
- Stored photo filenames are validated against `^[0-9a-f-]{36}\.(jpg|png|webp)$` before every disk operation. The
  values can only ever be API-generated uuids, but the string makes a round trip through the database and a path that
  escaped `SIGN_PHOTO_DIR` would read arbitrary files.
- Serialization goes through `api/src/lib/serialize.ts` like everything else (`serializeSign`, `serializeSignPhoto`,
  `serializePickup`, `serializeSignRequest`) — explicit allow-lists, so widening a join cannot widen a response.
  Signs carry no voter data; the joined `address`/`ward` are exactly the fields `serializeHousehold` already gives a
  volunteer, and `voter_name` on a sign request is `display_name`, which volunteers already get on their turf's doors.
- The sign list and the pickup list are **not** audited: they are logistics, and auditing every map refresh would bury
  the entries that matter. `GET /api/signs/requests` and every photo read are audited, because those are voter data.
- `sign.placed_by` / `removed_by` reference `app_user` without `ON DELETE`, so the test suite deletes the signs it
  created before the users that created them.

## Implementation notes (multi-voter contacts, doorstep phone/email)
- **No migration for either.** `db/migrations/002_voter_contact.sql` (table `voter_contact`, enum `contact_channel`)
  is already applied to `canvass` and `canvass_test`; the multi-voter change is pure API — it writes more rows into
  the `contact` table Phase 1 already had.
- The per-voter rows of one `POST /api/contacts` are written by a single `INSERT ... SELECT ... FROM unnest(...)`
  inside one transaction: the door-level fields are passed as scalars (every row shares them, and it keeps `issues`
  a single `text[]` rather than an array of arrays) and only `voter_id` / `support` / `client_id` are unnested. With
  a `client_id` the whole stored set is re-read inside the same transaction, so a partial replay (a client that
  added a second person to a submission it had already sent) still answers with every row.
- Derived idempotency keys mean the `client_id` a client sends is **not** the one stored when voters are named
  (`<client_id>:<voter_id>`). Anything that looks a contact up by client id — an offline queue reconciling its
  outbox — must match on the prefix, not on equality. A request that was in flight across this deploy is the one
  case that can double-write, because the pre-deploy attempt stored the bare key.
- `serializeContact` was added to `api/src/lib/serialize.ts` for the same reason as the rest: the insert uses
  `RETURNING *`, and a column added to `contact` later must not become part of the response by accident.
- Phone normalisation lives in `api/src/routes/voter-contacts.ts` (`normalizeContactValue`, exported for the tests).
  It is deliberately strict — a value that is not dialable is a GOTV send that silently goes nowhere, and a value
  stored in two formats defeats the `(household_id, channel, value)` UNIQUE key that makes a re-offer one row.
- The `201` / `200` split on `POST /api/voter-contacts` is decided by `(xmax = 0)` on the upsert's `RETURNING`,
  which is true only for a row that statement actually inserted — no second query.
- `voter_contact.collected_by` references `app_user` without `ON DELETE`, so the test suite deletes the
  voter contacts it collected before the users that collected them (and before the contacts they cite).
