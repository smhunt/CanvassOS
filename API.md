# Canvass API contract — Phases 1–2, plus lawn signs, doorstep contacts and Phase 5 messaging

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

### Street-level imagery of a door (optional, OFF by default)
- `GET /api/households/:id/streetview?w=640&h=400` → **the image bytes** for that door (`image/jpeg` or
  `image/png` as the provider sent them), so a canvasser can recognise the house before they walk up it — is it
  the one behind the hedge, are there steps, is there a gate.
  Sets `Cache-Control: private, max-age=900` (short on purpose — see the caching note below),
  `Content-Length`, `Content-Disposition: inline` and `X-Streetview-Provider`.
  - **Scoped exactly like `GET /api/households/:id`** (the same `lib/scope.ts` helper, not a second
    implementation): organizer/admin any door, volunteer only a door inside one of their assigned turfs,
    otherwise `403 not_your_turf`. Scope is checked before the row is loaded.
  - `503 { code: "streetview_disabled" }` when no `STREETVIEW_API_KEY` is configured — **this is the default**.
    Checked before anything else: the answer is identical for every id, role and caller, so it discloses nothing.
  - `404 { code: "no_imagery" }` when the provider has no panorama near the door (common on rural concession
    roads) **or** when the household has no coordinates at all (every `H-LEGAL-*` row, plus the handful of
    unmatched civic rows). Nothing is sent to the provider in the second case.
  - `502 { code: "streetview_unavailable" }` when the provider errors (revoked key, lapsed billing,
    `OVER_QUERY_LIMIT`, a timeout). The provider's own status goes to the log, never to the response.
  - `400 validation_error` when `w`/`h` are outside **100–640**. Both default to `640`×`400`. The cap is a
    spending control as much as a provider limit: every distinct pixel size is a separately billed image.
  - Rate-limited to **40/minute per user** (per user, not per IP — a canvassing team shares one LTE NAT).
  - Audit `view_streetview` with `{ available, provider }`, plus `{ size }` when an image came back. There is no
    `cached` flag because there is no byte cache: every `200` is one fresh, billed image request. A
    `404 no_imagery` is audited too — the door's coordinates still went to a third party.

**Why the endpoint exists at all, rather than a key in the browser.** The doors come from the voters list, and
s. 23(8) of the *Municipal Elections Act, 1996* says a recipient of that list "shall not provide it to any other
person". The design that resolves this:
- **Coordinates only.** What crosses the wire to the provider is `location=<lat>,<lon>` — never a name, never an
  address string, never a household id, never a session token. The lat/lon comes from Middlesex County's *public*
  open address data; the location of a house is not confidential. Who lives there is, and it never leaves the server.
- **Proxied, so the key stays server-side.** A key in client JavaScript is both a billing risk and a disclosure:
  the requests would carry the campaign's `Referer`, tying "which doors are being looked at, in what order" to the
  campaign. Proxied, the provider sees one server asking about coordinates.
- **Nothing is stored — not on disk, not in memory.** A directory of 7,000 photographs of electors' houses keyed
  to the voters list is exactly the artefact s. 23 exists to prevent, and Google's terms forbid it independently
  (below). The one thing `api/src/lib/streetview.ts` remembers is the **panorama id** for a coordinate (or `null`
  for "asked, nothing here"), bounded to 2,000 entries with a 6 h TTL, in process memory, gone on restart —
  a `pano_ID` is the single value the Maps Service Specific Terms expressly permit storing.
- **The free metadata endpoint is checked first.** `/maps/api/streetview/metadata` answers "is there imagery
  here?" at no charge, which is both how the honest 404 is produced and how the campaign avoids paying for a grey
  "no imagery available" placeholder on every rural door.
- **Off by default.** Absent the key the feature does not exist; the UI renders nothing at all.

**Provider, terms and cost** (`STREETVIEW_PROVIDER=google` → Google Street View Static API; checked
September 2026, all figures USD and subject to change — re-check before enabling):

- **Cost.** SKU *Static Street View* (`9BD0-A2EE-44C3`) is an **Essentials** SKU: **10,000 requests free per
  month**, then **$7.00 per 1,000** up to 100k. SKU *Street View Metadata* (`3168-48A9-5C8C`) is **free with
  unlimited use** — "Street View Static API metadata requests are available at no charge. No quota is consumed
  when you request metadata." The old recurring $200 monthly credit is gone, replaced by these per-SKU free caps.
  At 7,140 doors, a campaign that photographed **every** door once a month would stay inside the free cap; the
  realistic pattern (a volunteer glancing at the doors on their sheet) is comfortably free.
  *Note the SKU:* the JS panorama widget is *Dynamic* Street View, a **Pro** SKU at 5,000 free and $14.00 per
  1,000 — twice the price. This endpoint deliberately uses the Static API.
  → <https://developers.google.com/maps/billing-and-pricing/pricing>, <https://developers.google.com/maps/documentation/streetview/metadata>
- **Caching is prohibited, and that is why the byte cache was removed.** Maps Platform ToS §3.2.3(b): "No
  Caching. Customer will not cache Google Maps Content except as expressly permitted…"; §3.2.3(a) bars
  "pre-fetch, index, store, reshare, or rehost" and names "**Street View images**" explicitly. The **only**
  carve-out (Maps Service Specific Terms §A.3) is `pano_ID`, which "you can store… indefinitely". There is no
  30-day allowance for imagery — that applies to lat/lng from Places/Geocoding/Directions. §3.2.3(c) also bars
  *deriving* content from the imagery, which would cover running vision models over door photos: don't.
  The response therefore carries a short `Cache-Control: private, max-age=900` (a scroll-back window, not a
  stored copy) and no server-side copy of the bytes exists at any point after the reply is written.
  → <https://developers.google.com/maps/documentation/streetview/policies>, <https://cloud.google.com/maps-platform/terms>
- **Attribution is required and is the app's job.** The policies page requires Google Maps attribution wherever
  Maps Platform content is shown outside a Google map, and accepts the Google Maps logo or the words
  "Google Maps". Do **not** assume the returned JPEG carries a usable watermark — the "Image capture: Month
  Year" line belongs to the interactive panorama, not the static image, and §3.2.2(b) forbids modifying or
  obscuring whatever Google does supply. `web/src/map/StreetView.tsx` renders the words "Google Maps" with
  `translate="no"` under every photo, and the API sets `X-Streetview-Provider` so any other consumer knows what
  it has to credit.
- **Political / campaign use is not restricted.** Nothing in the Maps Platform ToS or the Google Cloud
  Acceptable Use Policy restricts political, election or campaign use. §3.2.1's restrictions are High Risk
  Activities, fee avoidance, export control/ITAR, HIPAA, Prohibited Territories and COPPA-directed children's
  services; a volunteer canvassing tool hits none of them.
- **Two obligations the campaign must actually meet before enabling this**, and they are not code:
  1. ToS §3.2.2(a) requires the app to have publicly accessible **Terms of Use and a Privacy Policy** telling
     users it uses Google Maps features and linking the Google Maps/Google Earth Additional Terms of Service and
     the Google Privacy Policy. Awkward for a login-only volunteer tool, but it is a hard requirement.
  2. The key must be restricted: **API restriction to Street View Static API only, plus an IP restriction to the
     server's egress address.** An HTTP-referrer restriction does nothing here — this is a web-service API called
     server-side, and the key never reaches a browser.
  → <https://developers.google.com/maps/api-security-best-practices>

**Why not an openly-licensed source.** Mapillary/KartaView imagery is CC BY-SA and free (a token is required;
nothing in the ToU bars campaign use), which would be a better licensing and privacy story — but the coverage is
not there for rural Middlesex. Sampling volunteer-contributed coverage within 3 km: Komoka 10,320 photos across
6 sequences, Arva 6,189/11, Coldstream 3,297/8, Denfield 572/4, **Ilderton 0** — and every sequence in the county
dates from **2017–2019**. That is a handful of individual drives down the main roads seven-plus years ago, with
nothing on most concession roads and nothing for the newer Komoka/Kilworth subdivisions. It is also
forward-facing dashcam footage from a moving car, so a property set back behind a treeline yields a mailbox, not
a door. Ontario GeoHub and ArcGIS Hub carry no street-level imagery for the county at all — only orthophoto.
**Worth knowing:** Middlesex County's own GIS publishes *Ontario Imagery 2023–2027* as a free WMS — current
high-resolution aerial, no per-request cost, no caching restriction, no coverage gaps. For a rural door it
arguably answers the canvasser's real question better than street level does (where is the driveway, where do I
park, which of these three buildings is the house). It is not this endpoint, but it is the strongest
unencumbered option and the map layer worth building next.


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
- `POST /api/turfs/preview` `{ ward?, streets?: string[], polygon?: GeoJSON Polygon }` → `200`
  ```
  { n_households, n_voters, unmapped, truncated,
    doors: [{ household_id, lat, lon, ward }] }
  ```
  The **same body as `POST /api/turfs` minus `name`** (`ward` may also be `null`), validated by the same rules —
  exactly one of `streets`/`polygon`, else `400`. It runs the **same selection code the create path runs**
  (`selectHouseholds()` in `api/src/routes/turfs.ts`, called by both this route and `materialise()`), so previewing
  and then saving the same body always yields the same doors: a preview that can disagree with the save is worse
  than no preview, because the organizer commits a walk on the strength of it. `ward` does not narrow the match
  here either.
  `n_households` / `n_voters` are the exact totals for the whole selection. `unmapped` is how many of those
  households have no coordinates (legal descriptions) and therefore cannot appear as dots — without it the map
  quietly shows fewer doors than the count promises. `doors` is capped at **4,000** points (the whole municipality
  is 7,067 and one existing turf is already 1,330); when the cap bites, `truncated` is `true` and the counts are
  still the full figures. Nothing is written and no turf is created.
  Audit `preview_turf` with `{ by: "streets" | "polygon", n_households }` and a `null` target.
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

## Messaging — opt-in SMS and email (Phase 5)
**This subsystem can text thousands of real people, so the contract below is written around making that impossible
to do by accident.** Consent already lives in `voter_contact` (migration 002); this is everything downstream of it —
campaigns, a per-recipient send row, a pool of sending numbers, inbound STOP/JOIN, and a throttled send worker
(`db/migrations/003_messaging.sql`).

### Why there is no "send to everyone" endpoint
An unregistered Canadian local **long code carries roughly 100–250 messages per day, and the excess fails
*silently*** — not queued, dropped (`docs/phase-5-messaging-plan.md` §1.1). The arithmetic that follows is the
single most important fact about this API:

| Audience | One number | Ten numbers | Forty numbers |
|---|---|---|---|
| 2,000 subscribers | 8–20 days | 1–2 days | hours |
| 17,000 electors | 70–170 days | 7–17 days | 2–4 days |

So the transport cannot honour "text everyone on Sunday night", and an endpoint that offered it would be a lie that
fails *after the polls close* — the worst way for a GOTV tool to fail. What the API offers instead is an audience
count with an honest `estimated_days`, and a send that **drips**: throttled per number, paused at quiet hours,
resumable, with per-recipient progress. **Cost is not the constraint; throughput is.**

### The four brakes
1. **`MESSAGING_PROVIDER` defaults to `log`.** The log provider writes the `message_send` rows, logs one line per
   message, and puts nothing on the wire. Every endpoint, the worker, the number pool, the caps and the quiet hours
   run exactly as in production — only the last inch is a log call. Real sending needs `MESSAGING_PROVIDER=twilio`
   **and** credentials; both are absent by default and the API refuses to boot with one without the other.
2. **A campaign cannot leave `draft` without an approver.** `POST /:id/approve` is a *separate call* from
   `POST /:id/send`; `/send` returns `409 not_approved` otherwise. An approved campaign is also frozen —
   `PATCH` returns `409 already_approved`, so nobody can approve a benign draft and then swap the body.
3. **`MESSAGING_MAX_AUDIENCE` (default 5000)** — `/send` returns `409 audience_too_large` unless the body says
   `{ "override_max_audience": true }`.
4. **The throttle lives in the worker**, not in the endpoints, so no request can bypass a daily cap or quiet hours.

### Channel priority — SMS first
One resolver decides how a person is reached, and both the count and the queue go through it, so the number an
organiser approves is the number of messages that leave:
1. a `phone` contact with the campaign's consent flag and no `withdrawn_at` → **SMS**;
2. otherwise an `email` contact on the same terms → **email**;
3. otherwise not reachable — where most electors are, and that is fine.

Somebody who gave both is an SMS recipient and is **not also** counted or queued as an email one: one message per
person per campaign, never two. Then messages are **deduped by number/address**, so two households that wrote down
the same phone number get one text. Consent is **per purpose**: a `gotv` campaign may not reach somebody who only
agreed to `updates`.

### Endpoints
- `GET /api/messaging/audience?purpose=gotv|updates&ward=01,02&community=KOMOKA` — **organizer/admin**, audited
  (`view_audience`) on every call. →
  ```
  { sms, email, unreachable, total, daily_capacity, estimated_days }
  ```
  `sms` / `email` are **messages** (after SMS-priority and after dedupe). `total` is **electors** in scope and
  `unreachable` is electors no message would reach, directly or through their household's contact. **These do not
  sum**: `sms + email + unreachable ≠ total`, because one message can cover a household of several electors — and
  because deduping two households onto one number removes a redundant *message*, not a person's reachability.
  `daily_capacity` is the sum of `daily_cap` over **active** sender numbers; `estimated_days` is
  `ceil(sms / daily_capacity)`, or **`null`** when there are no active numbers (unknown, rather than a `0` or an
  `Infinity` that would read like an answer).
- `POST /api/messaging/segments` `{ text }` → `{ chars, segments, encoding, offending }`. Any signed-in user; pure
  arithmetic, no database. `encoding` is `GSM-7` (160 chars/segment, 153 multipart) or `UCS-2` (70/67). **A single
  character outside GSM-7 re-encodes the whole body**, so `offending` lists the distinct characters responsible, in
  order of first appearance — the composer shows those, because "3 segments" alone tells nobody what to fix.
  Worth knowing precisely: **`é`, `à` and `Ç` are in GSM-7 and cost nothing.** What bites is the typography a word
  processor inserts for you — the curly apostrophe `’` for `'`, the em dash `—` for `--`, smart quotes — plus a
  lower-case `ç` or `œ`. `chars` counts code points, so an emoji is one character but two UCS-2 units. `€ { } [ ] ~
  ^ \ |` are GSM-7 but cost **two** septets each. An empty body is `0` segments.
- `GET /api/messaging/campaigns` → `{ campaigns: [...] }`, newest first, max 200. **Organizer/admin.**
- `POST /api/messaging/campaigns` → `201 { campaign }`, always `status: "draft"`.
  ```
  { name, purpose, body_sms?, email_subject?, body_email?, audience?: { ward?: [], community?: [] }, scheduled_for? }
  ```
  Audit `create_campaign`.
- `GET /api/messaging/campaigns/:id` → `{ campaign }`.
- `PATCH /api/messaging/campaigns/:id` — **draft and unapproved only**: `409 not_draft` / `409 already_approved`.
  Audit `update_campaign`.
- `POST /api/messaging/campaigns/:id/approve` → `{ campaign }` with `approved_by` / `approved_at` set. The status
  stays `draft` — approving is not sending. `409 already_approved`, `409 not_draft`, `400 empty_body`.
  Audit `approve_campaign`.
- `POST /api/messaging/campaigns/:id/send` `{ override_max_audience?: boolean }` →
  `{ campaign, queued, estimated_days }`. Resolves the audience, writes **one `message_send` row per recipient**
  (`UNIQUE (campaign_id, voter_contact_id)`, which is what makes "did she get it?" answerable and what stops a
  retry sending twice), moves the campaign to `sending`, and kicks the worker. **Nothing is sent by this request.**
  `409 not_approved`, `409 not_draft` (so a double click queues nothing twice), `409 audience_too_large`,
  `400 empty_audience`. Audit `send_campaign`.
- `POST /api/messaging/campaigns/:id/pause` (`409 not_sending`) · `/resume` (`409 not_paused`) ·
  `/cancel` (`409 not_cancellable`). Cancelling marks every still-queued row `skipped` with
  `skip_reason: "cancelled"` rather than deleting it — "we decided not to send this" is a fact about that recipient
  worth keeping. Audits `pause_campaign` / `resume_campaign` / `cancel_campaign`.
- `POST /api/messaging/campaigns/:id/test` `{ to }` → `{ sent, provider, provider_message_id, chars, segments,
  encoding, offending }`. Sends the draft body to **one** number, bypassing the audience and the queue entirely.
  Allowed at any status, approved or not — the `’` trap is cheapest to catch here — and **always audited**
  (`test_send`), because with a live provider it is still a real message to a real handset. It takes a number from
  the pool and counts against that number's daily cap. `400 empty_body`, `400 invalid_phone`.
- `GET /api/messaging/numbers` → `{ numbers: [...], daily_capacity }` · `POST /api/messaging/numbers`
  `{ e164, label?, provider?, daily_cap?, active? }` → `201 { number }` (`409 number_exists`) ·
  `PATCH /api/messaging/numbers/:id` `{ label?, daily_cap?, active? }`. **Organizer/admin.** `daily_cap` defaults to
  **100** and is capped at 1000: the reported ceiling is 100–250 and the excess is dropped without an error, so
  guessing high loses messages invisibly. Audits `create_sender_number` / `update_sender_number`.

### Public — `POST /api/subscribe` (no auth)
```
{ phone, wants_gotv?, wants_updates?, consent_text }        → 202 { ok: true, message }
```
**Double opt-in.** The form writes a `subscribe_pending` row and the number is texted once; consent is created only
when *the handset itself* replies `YES` to the inbound webhook. This is the only consent route where we cannot see
the person, so it gets the strictest proof.

- **The response never reveals whether a number is already known** — subscribed, withdrawn, or never heard of, the
  `202` body is byte-identical. Otherwise the form is a free oracle over the campaign's contact list: type a number,
  read the answer, learn whether that person gave the campaign their phone number.
- **A number that previously said STOP is silently never texted by this route.** They can still come back by
  replying `JOIN` from their own handset.
- **One confirmation per outstanding request**, plus a hard **5 requests/hour per IP** (`429 rate_limited`). Both
  are needed: the rate limit stops one caller texting a thousand people, the outstanding check stops a thousand
  callers texting one person.
- `consent_text` (20–1000 chars) is the **verbatim wording shown beside the tick box**, stored exactly as given.
  A consent record that cannot say what was agreed to is not a consent record.
- `400 invalid_phone` (a typo discloses nothing and would otherwise leave somebody waiting for a text that can never
  arrive), `400 consent_required` if neither purpose is wanted. Audit `subscribe_request` with a **null** user_id —
  nobody on the campaign did this, the subscriber did.

### Webhooks — no session, provider-signature verified
`POST /api/messaging/inbound` and `POST /api/messaging/status`. Bodies are `application/x-www-form-urlencoded`
(Twilio field names `From` / `To` / `Body` / `MessageSid` / `MessageStatus` / `ErrorCode`; lower-case aliases also
accepted). Authentication is the provider's own signature (`X-Twilio-Signature`, HMAC-SHA1 over the configured URL
plus the sorted form fields) **plus** the optional `MESSAGING_WEBHOOK_TOKEN` shared secret, which applies to *every*
provider including `log` and is passed as `?token=` or `X-Webhook-Token`. Failure is `401 invalid_signature` /
`401 invalid_webhook_token`. This is not ceremony: an unauthenticated `POST /inbound` with `Body=JOIN` would mint
consent for a number of the caller's choosing.

**Inbound keywords** are matched case-, space-, punctuation- and accent-insensitively, so `Arrêt.`, `ARRET` and
`a r r e t` all land in the same branch.
- **STOP** — `STOP`, `UNSUBSCRIBE`, `ARRÊT`/`ARRET`, `DÉSABONNEMENT`, `CANCEL`, `QUIT`, `END`, `STOPALL`. Stamps
  `withdrawn_at` (coalesced, so a second STOP keeps the moment they *first* asked) on **every** matching
  `voter_contact`, immediately, and replies once with a confirmation. **Honoured and recorded even when the number
  matches nothing we hold** — a person telling us to stop is telling us to stop whether or not we can find them, and
  if that number is collected at a door later the inbound row is there to say they already said no. Messages already
  queued to that number are caught by the worker's dequeue-time re-check. Audit `inbound_stop` with
  `{ matched, from_known }`.
- **JOIN** — `JOIN`, `YES`, `OUI`, `START`, `UNSTOP`. Confirms an outstanding `subscribe_pending` if there is one
  (recording that row's exact `consent_text`), otherwise treats the text itself as the consent and records it
  verbatim (`Text-to-join: replied "…"`). **A JOIN also lifts a previous withdrawal** — the one place a withdrawal
  is reversible, and only by the person's own outbound text, timestamped by the carrier. Nothing an organiser can
  click undoes a STOP. Audit `inbound_join`.
- **HELP** — `HELP`, `AIDE`, `INFO`. Replies with who we are and how to stop.
- Anything else is stored with `action: 'other'` and gets no reply.

`provider_message_id` is `UNIQUE` on `message_inbound` and is used as the idempotency key: a carrier retrying its
webhook returns `{ ok: true, action, duplicate: true }` and does not send a second confirmation.

`POST /api/messaging/status` moves `sent` → `delivered` (`delivered_at`), and `undelivered`/`failed` → `failed` with
the carrier's own reason. **This is how a silent carrier throttle is detected, and it is the entire reason
`delivered_at` exists as a column distinct from `sent_at`.** A long code over its allowance does not return an
error: the provider accepts the message, we mark it `sent`, and the carrier drops it. From our side that failure is
invisible — the send looks like a complete success right up until election day. The only signal is the receipt that
never arrives, so a campaign whose `sent` count climbs while `delivered` stays flat is being throttled. Receipts are
not polish; they are the smoke detector for the one failure mode that would otherwise be found after the polls close.

### Campaign shape
```
{ id, name, purpose, body_sms, email_subject, body_email, status, scheduled_for, audience,
  created_by, created_by_name, created_at, started_at, finished_at,
  approved_by, approved_by_name, approved_at,
  sms_segments, sms_encoding,
  progress: { total, queued, sent, delivered, failed, skipped } }
```
`status` ∈ `draft` | `scheduled` | `sending` | `paused` | `done` | `cancelled`. `sms_segments` / `sms_encoding`
travel with the campaign so a reviewer sees the bill *before* approving, not after. In `progress`, **`sent` and
`delivered` are distinct counts, not cumulative** — see the paragraph above.

### The send worker
Drains `message_send` rows with `status = 'queued'` whose campaign is `sending`, oldest first, one at a time, each
claimed with `SELECT … FOR UPDATE … SKIP LOCKED` inside a transaction that is held across the provider call — so
calling `/send` twice, or racing two workers, takes *different* rows and no message goes twice. One drain runs per
process at a time.

- **Consent and withdrawal are re-checked at dequeue, never trusted from queue time.** A list built on Friday must
  not deliver on Sunday to somebody who said stop on Saturday. Those rows become `skipped` with `skip_reason`
  (`withdrawn`, `no_consent`, `cancelled`) — a different and far more useful fact than `failed`.
- **Quiet hours**: 09:00–21:30 weekdays, 10:00–18:00 weekends, **America/Toronto**, computed through `Intl` so the
  late-October DST change is handled. Outside the window the worker **waits** — rows stay queued and go out when it
  reopens. (Strictly these are the CRTC telemarketing/ADAD hours rather than SMS rules; a text at 07:00 costs
  goodwill regardless.) `MESSAGING_QUIET_START` / `_END` set the weekday bounds; the weekend **narrows** them, so
  tightening the config tightens the weekend too and can never widen it.
- **Daily caps**: a message is only sent against a `sender_number` with `sent_today < daily_cap`; `sent_today` rolls
  over when `cap_reset_on` passes. When the pool is exhausted the worker stops for the day rather than posting into
  a void. Email has no long-code throttle and needs no number.
- **Retries**: a transient provider failure (429, 5xx, a dropped connection) is retried with backoff up to 5
  attempts. A **hard rejection** (invalid number, carrier block) marks the row `failed` with the provider's own
  reason and is **not** retried — retrying burns daily cap a deliverable message needed.
- A campaign with nothing left queued becomes `done` with `finished_at`, including one whose every row was skipped.

### Not built, deliberately
No "send to the whole list" button (see above). No merging with the voters list — a send never exports list data to
the provider, only the number and the body. No robocalls: the ADAD solicitation ban needs counsel before anyone
touches voice. No pre-checked consent, anywhere.

**Two gates before the first real send, neither of them code**: a provider's written confirmation on Campaign Verify
scope for a Canadian sender and real long-code throughput, and a lawyer's read on the CASL position for a
non-commercial political SMS from a municipal candidate (`docs/phase-5-messaging-plan.md` §4).

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

- `GET /api/turfs/shapes` → **any signed-in role**, scoped. The turf boundaries for the map overlay.
  ```
  { turfs: [{ id, name, ward, polygon, mine, n_households, contacted }] }
  ```
  A volunteer gets only the turfs assigned to them; an organiser or admin gets every active turf
  with `mine` set on their own. The scope is a WHERE clause, not a filter after loading. `polygon`
  is null for a turf built by picking streets. Deliberately narrow — a name, a shape and two counts,
  no door list — so it can be fetched for the whole municipality without being a bulk read.

- `GET /api/stats/reachability` → organizer/admin. Why part of the list cannot be reached.
  Aggregates only — no name, address or id is in the response, which is what makes it safe to hand
  to an advice provider. Audited as `view_reachability`.
  ```
  { totals:   { households, voters, wards: ["01","02",...] },
    categories: [{
      code,          // no_map_point | legal_description | geocode_failed | institution |
                     // po_box_only | non_resident | class_unknown |
                     // do_not_knock | inaccessible | moved | deceased | refused
      kind,          // structural (off the list) | behavioural (recorded at a door)
      blocks,        // ("door" | "mail" | "gatekeeper")[] — WHICH channel this rules out
      parent,        // set when this is a cause of another row (geocode_failed -> no_map_point)
      scope,         // "household" | "voter" — count is doors OR electors; never compare them
      count, share,
      by_ward: [{ ward, count, share }]
    }],
    combined: { households_blocked, share,      // doors that genuinely cannot be knocked
                mail_blocked, mail_share },     // doors that cannot take addressed mail
    advice                                      // string, or null when ADVICE_API_KEY is unset
  }                                             // or the provider call failed
  ```
  **`combined.households_blocked` is door-only and de-duplicated.** It excludes `po_box_only`
  (which blocks lettermail, not the door) and `institution` (knockable, via the administrator).
  Including them would report 390 blocked doors where there are 73. Categories overlap, so no field
  here is the sum of the rows above it.

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
- Env (street-level imagery, both optional): `STREETVIEW_API_KEY` — **absent means the feature is off**, which is
  the default; when set it stays on the server and is never served to the browser. `STREETVIEW_PROVIDER` —
  `google` (the default and currently the only accepted value; a zod enum, so a typo fails boot rather than
  silently disabling the feature).
- Env (messaging, all optional and **all defaulting to "send nothing"**): `MESSAGING_PROVIDER` — `log` (default)
  or `twilio`; `log` writes the send rows and logs, and puts nothing on the wire. `MESSAGING_MAX_AUDIENCE` —
  default `5000`, the ceiling `/send` refuses to cross without an explicit override. `TWILIO_ACCOUNT_SID` /
  `TWILIO_AUTH_TOKEN` — required *together with* `MESSAGING_PROVIDER=twilio`; the API refuses to boot with the
  provider set and the credentials missing, so a half-configured stack fails at startup rather than silently at 3am
  mid-send. `MESSAGING_QUIET_START` / `MESSAGING_QUIET_END` — `HH:MM`, default `09:00` / `21:30`, the weekday
  sending window in America/Toronto (weekends are narrowed to 10:00–18:00 within it). `MESSAGING_ORG_NAME` — how
  the campaign names itself in an automated STOP/HELP/JOIN reply, default `This campaign`.
  `MESSAGING_WEBHOOK_TOKEN` — optional shared secret (≥16 chars) checked on both provider webhooks **in addition
  to** the provider signature and for every provider; a stack reachable from the internet should set it.
- The API makes exactly two kinds of outbound HTTP request: the Street View provider call above, and the messaging
  provider call — both via injectable seams (`app.httpFetch` and `app.messaging.provider`), so the test suite stubs
  them and **no test ever makes a real, billed call**. With the default `MESSAGING_PROVIDER=log` the second one does
  not exist at all.
- Logging: pino, request ids; never log request bodies on auth routes.

## Implementation notes (Phase 1 backend — clarifications, no shape changes)
- `stats.household_size[].size` is a **string label**: `"1"`, `"2"`, `"3"`, `"4"`, `"5"`, `"6+"`.
- `stats.totals.nonresidents` / `by_ward[].nonresidents` / `by_community[].nonresidents` count voters with
  `resident_class = 'non-resident'` (**390** in the currently loaded data). `household.n_nonresident`
  (used by `points.nonres`) is the pipeline's count and also includes the 4 `unknown` voters (**394**).
  The often-quoted 337/341 are the *original* pipeline's figures; that pipeline was lost and
  `pipeline/build_lists.py` is a reconstruction — see README "Rebuilding the importer's inputs". `totals.po_box_only` = households where every
  voter's mailing address is a PO box (`n_po_box >= n_voters`).
- `GET /api/households/legal` rows are the household card fields (no `voters` array) plus `voter_names`
  ("A; B; C") for listing.
- `GET /api/households/:id` `status` is always present; `{ last_result: null, last_contact_at: null, last_user_name: null }`
  when the door has never been contacted. `voters[]` are ordered by last name, first name.
- `GET /api/households/points` is served as `application/geo+json`; coordinates are rounded to 6 decimals.
  Volunteers' features carry only `{ id, ward, community, n, inst }`; the contact lookup is skipped for them.
- `GET /api/audit` also accepts `user_id=<uuid>` and `action=<name>` filters; entries are
  `{ id, at, user_id, user_email, user_name, action, target, detail, ip }`. Extra audited actions:
  `login_failed`, `accept_invite`, `change_password`, `reinvite`, `update_user`. Phase 2 adds `preview_turf`, `create_turf`,
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
- The turf **matching lives in exactly one function**, `selectHouseholds()`: `POST /api/turfs/preview` and the
  `materialise()` step of `POST /api/turfs` both call it, and `walk_order` is then numbered over the order it
  returned. Adding a second query for the preview is the bug this shape exists to prevent.
- A preview that matches nothing is a `200` with `n_households: 0` and an empty `doors` array, not a `404`.
  A polygon preview always reports `unmapped: 0` — a household with no coordinates cannot be inside a
  drawn shape in the first place; only a street selection can pick up legal descriptions.
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

## Implementation notes (street-level imagery)
- **No migration, no table, no file on disk.** The feature adds one route, one library
  (`api/src/lib/streetview.ts`) and one audit action; nothing about it is persisted anywhere except the
  `audit_log` row saying somebody looked.
- `buildApp` now decorates `app.httpFetch`. It is the only outbound HTTP in the stack and it is injectable
  (`BuildOptions.fetchImpl`) so the test suite hands in a stub — the suite asserts that the stub is only ever
  given two numbers as `location`, and no test makes a real, billed request.
- Order of checks in the handler is load-bearing: parse → **feature switch** → **turf scope** → row → provider.
  The switch is global state (identical for every id and every role), so answering `503` before touching the
  database discloses nothing about the household and costs nothing when nobody has enabled the feature. Scope is
  still checked before the row is loaded, so an out-of-turf volunteer gets `403` and never learns whether the id
  exists — and their `403` is issued before any coordinate is sent anywhere.
- The image request deliberately sends **no `heading`**. Given a `location` rather than a `pano`, Google aims the
  camera from the nearest photograph towards that point, which is exactly "look at this door". It also sends
  `source=outdoor` (an indoor business photosphere is not a door anyone can find), `radius=100` (Google's default
  is 50 m, which misses farmhouses set well back from the road allowance where the camera car actually drove —
  and rural doors are the ones a canvasser most needs to recognise) and `return_error_code=true` (so a panorama
  that vanished between the metadata check and the image call is a 404, not a billed grey placeholder).
- There is exactly one cache and it holds **panorama ids**, not pixels: `coordinate → pano_id | null`,
  insertion-ordered with a hard 2,000-entry cap and a 6 h TTL. A remembered `null` short-circuits the whole
  request, which matters because "no imagery here" is the answer for a lot of Middlesex Centre; a remembered id
  only saves the (free) metadata round trip, because the image must be re-fetched every time.
  `clearStreetViewCache()` drops it and is what the tests call between cases. An earlier draft of this feature
  cached the image bytes for 30 minutes to avoid double-billing; ToS §3.2.3 is what removed it, and the test
  "checks the free metadata endpoint before the billed image" now asserts the second view really does re-fetch.
- `web/src/map/StreetView.tsx` is a plain `<img>` at the endpoint — the session cookie rides along, so there is no
  fetch/blob dance and the browser's own cache honours `Cache-Control: private`. Every failure mode (503, 404,
  502, offline) reaches it as one image `error` event and it renders `null`: no broken frame, no error message,
  and no space taken. Like the sign photos it offers no download, share or open-in-new-tab affordance.

## Implementation notes (messaging)
- **Files.** `src/messaging/provider.ts` (the `send(to, body) → { providerId, segments }` adapter, with `log` and
  `twilio` implementations and webhook signature verification), `src/messaging/audience.ts` (the one channel-priority
  resolver, used by both the count and the queue so they cannot drift), `src/messaging/worker.ts` (the drip),
  `src/messaging/inbound.ts` (keyword folding, STOP/JOIN application), `src/lib/segments.ts` (GSM-7/UCS-2 maths),
  `src/lib/quiet-hours.ts` (pure, clock-injectable), `src/routes/messaging.ts`, `src/routes/subscribe.ts`.
- **Provider injection.** `buildApp({ provider })` overrides the configured provider, exactly as `fetchImpl` does
  for Street View. `app.messaging = { provider, worker }`; `worker.drain({ at, limit })` is callable directly with a
  fixed clock, which is how quiet hours and cap rollover are tested without waiting on a real one.
- **`audience` narrowing** is stored as jsonb on the campaign — `{"ward": ["01"], "community": ["KOMOKA"]}` — and
  parsed leniently: unknown keys are ignored, communities are upper-cased, an empty list means "no filter". The
  query-string form accepts comma-separated values.
- **`scheduled_for` is stored but not yet acted on.** The `scheduled` status exists in the enum and the column is
  accepted on create/patch; nothing transitions a campaign into it and the worker does not auto-start one. A send is
  started by `POST /:id/send`. (Given that a GOTV drip has to begin *days* before it is meant to land, the honest
  primitive is the drip itself, not a scheduler on top of it.)
- **Email is genuinely the fallback.** `message_send` carries email rows and the worker drains them, but the
  provider interface's `sendEmail` is optional: the `log` provider implements it, `twilio` does not, and an email row
  under a provider that cannot carry it is marked `failed` with that reason rather than silently pretending it went.
  A real email sender is a new implementation of the same interface.
- **A self-serve subscriber whose number we do not already hold cannot yet be added to a send audience.**
  `voter_contact.household_id` is `NOT NULL REFERENCES household(id)` — correct for a number collected at a door,
  which belongs to an address on the list, but there is nowhere to put a number from somebody who is not on it. So
  `JOIN` records the consent (the `subscribe_pending` row is confirmed and the inbound message is stored with the
  carrier's own timestamp, which is fully provable) and updates any `voter_contact` rows that already hold that
  number — but it cannot create one from nothing, and `message_send.voter_contact_id` is `NOT NULL`, so such a
  subscriber is not yet reachable by a campaign. Closing this needs a schema decision (a nullable `household_id`, or
  a separate `subscriber` table), which is flagged here rather than guessed at.
- **Audit.** `view_audience`, `create_campaign`, `update_campaign`, `approve_campaign`, `send_campaign`,
  `pause_campaign`, `resume_campaign`, `cancel_campaign`, `test_send`, `create_sender_number`,
  `update_sender_number`, `inbound_stop`, `inbound_join`, `subscribe_request`. The last three carry a **null**
  `user_id` — nobody on the campaign performed them, the recipient did, and that is precisely why they are recorded:
  a consent or a withdrawal is only defensible if we can show when it arrived. As everywhere else in this API, the
  audit `detail` never contains the phone number or address itself.
