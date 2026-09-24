# CanvassOS — build plan

Self-hosted (Docker) voter map + canvassing tool for the Sean Hunt mayoral campaign.
Users: Sean (admin), a small core team (organizers), volunteers on phones at the door.

---

## Status — 2026-09-15

**Released as 1.0.0** and renamed CanvassOS. Phases 1, 2, 3 and 5 are shipped, Phase 4 is partly
shipped, and the tool is running the campaign's canvass on the real list at
https://canvass.webarchitecture.ca. What 1.0 deliberately leaves out: coverage and support reports by
ward/community/turf/day, CSV export with an audit entry per download, in-app notifications
(`docs/phase-7-notifications-plan.md`) and geo-targeted advertising
(`docs/phase-6-advertising-plan.md`).

Everything below this section is the **original plan, unedited**: a record of what was intended, not of
what happened. This section is the difference between the two. `CHANGELOG.md` has the release-by-release
detail; `docs/README.md` describes what the code actually does now.

**Where it runs, as of 2026-09-24 (1.5.0):** the EC2 box, `/srv/canvass`, reached as
`ssh canvass-prod`. Production left the office Mac that day and the Mac's containers are stopped, so
operator commands only reach production through that alias — see README "Cutting production over to
AWS", which is now a record of something done rather than a plan. The lawn-sign delivery list also
stopped being derived from `contact.wants_sign` alone: a request can be raised from any door card
with no visit behind it, typed in by hand from a phone call, or arrive off the website, and all four
origins merge into one list that can be corrected, cancelled with a reason, and restored.

| Phase | State | Notes |
|---|---|---|
| 1. Foundation + read-only viewer | **shipped** | Compose stack, `db/schema.sql`, the Python importer, login/roles/invites, full-municipality map with filters and search, household card, stats dashboard. 7,140 households / 16,892 voters loaded; 7,067 mapped, 70 legal descriptions, 11 institutions. |
| 2. Canvassing core | **shipped** | Turfs from picked streets *or* a drawn polygon, `turf_household.walk_order`, assignments, the door screen with results/support/notes/flags, latest-status colouring on the map, follow-up queue, per-user activity. |
| 3. Field hardening | **shipped** | PWA install and the app-shell service worker shipped back in Phase 1; walking order along the street shipped with turfs. Now added: the offline turf cache and write queue (`web/src/offline/` — IndexedDB, backoff, parked entries surfaced to the volunteer), nearest-first ordering from device GPS (`web/src/canvass/nearMe.ts`, with walk order still the default), the printable turf sheet at `/turfs/:turfId/sheet`, the add-to-home-screen path, a held queue for sign photos taken offline, and a four-stop breakpoint scale that gives iPads a master-detail door screen instead of desktop density under a finger. |
| 4. Reporting + admin | **partly** | Encrypted backup/restore and `make purge` shipped in Phase 1; the audit log and admin user management with it. Since added: the **reachability report** (`/reports?tab=unreachable`, `GET /api/stats/reachability`) with optional Claude-written advice from aggregate counts only. Since 2026-09-15 also the **diff-based list re-import** (`make import-diff`, then `make import-apply`), which updates the list in place and keeps every contact, sign, consent record, turf and sign-up. **Not landed:** coverage/support reports by ward/community/turf/day, and CSV export with audit entries. |
| 5. Messaging | **shipped** | Opt-in SMS with email fallback: per-purpose consent, STOP honoured before the next queued send, CRTC sending window and weekend hours enforced in code, a test-send-to-yourself gate and a typed-word approval before anything leaves, and a drip scheduler because a Canadian long code is throttled to ~100-250/day and the excess fails silently. `MESSAGING_PROVIDER=log` by default: a real send needs both a live provider and its credentials, and the API refuses to boot with one without the other. |

### Since 1.0 — 2026-09-17

Three things, none of them features. Released as **1.0.1**; `CHANGELOG.md` has the detail.

- **`TRUST_PROXY` was being read as a boolean.** `TRUST_PROXY=1` reached Fastify as `true`, which
  tells `proxy-addr` to trust every hop and so to return the *left-most* `X-Forwarded-For` entry —
  the one the caller supplies. `req.ip` is `audit_log.ip` and the login rate-limit key, so both were
  forgeable by anyone who could reach the origin directly. It is a hop count now. Not exploitable on
  the live stack, which runs `Caddyfile.tunnel`, but it would have been the first time `make up` was
  used on an internet-facing host. The plain `Caddyfile` now overwrites the header too, so the fix
  does not depend on the API alone.
- **Backups were encrypted with an empty passphrase.** macOS ships GNU Make 3.81 and `.ONESHELL`
  arrived in 3.82, so the declaration at the top of the Makefile was silently ignored on the machine
  that runs the campaign: `$$PASS` was set in one shell and read in another, and `set -o pipefail`
  never reached the `pg_dump | gzip | gpg` pipeline. Nobody noticed because no backup had ever been
  taken. Fixed, and off-site backups added on top — `make backup-offsite` to S3 with each upload
  verified, `make purge-offsite` to destroy them afterwards and prove the bucket is empty.
- **Moving off the office Mac.** A machine that sleeps, leaves the network or reboots to a login
  screen takes the canvass down mid-shift. Mode C is the same `make up-tunnel` stack on an EC2 host
  in `ca-central-1` (so the list stays in Canada), with no inbound security-group rule at all and
  SSM instead of SSH. It must be **x86_64**: `postgis/postgis` publishes no arm64 image on any tag,
  and it only appears to work on Apple Silicon because Rosetta emulates amd64.

### Drive mode — 2026-09-18

**Not in any phase of the plan below, and not a phone-in-hand feature.** Middlesex Centre is rural:
outside the settlements a turf is concession roads with a door every few hundred metres, and that is
driven, not walked. `/canvass/:turfId/drive` is a glanceable screen for a phone in a car mount which
names the next door *ahead* — how far, which side of the road, how many are on the list there — and
moves on by itself as the vehicle passes. Released as **1.1.0**; `CHANGELOG.md` has the detail and
`docs/README.md` §5 has the maths.

- **Ahead, not nearest.** The closest door to a moving car is frequently the one just passed, so each
  door is projected onto the vehicle's course into an along-track distance and a cross-track offset
  rather than sorted by plain range. The door already on screen is held through a wider band than a
  fresh one has to pass: one shared threshold is a flicker generator, not hysteresis. With no course
  at all — parked, or a phone that reports none — it is nearest-first, still holding the door it had.
- **It talks, and it is quiet when it should be.** Handling a phone while driving is an offence in
  Ontario, so a solo canvasser has to be able to work this screen without touching it: the next door
  is spoken, the screen is held awake, and a one-time notice asks the driver to mount the phone and
  drive on a charger before the first door appears. Nothing is said while there is no heading, because
  a stopped car flips between course and no course and would hear the same door over and over. **No
  name is ever spoken**, whatever the on-screen Names toggle says — a voice carries outside the car,
  and Chrome may synthesise through a remote voice, which would send the text to a third party.
- **Nothing to record with.** Deliberately read-only: results are still entered at the door, on the
  door screen. Drive mode answers "where next", which is the only question that can be answered
  safely at the wheel.

### Help that talks, and a choice of voice — 2026-09-20

**Also outside the plan, and it grew out of drive mode.** A driver cannot read instructions, so the
screen has to be able to explain itself by ear. Released as **1.2.0** and **1.3.0**.

- **First use speaks (1.2.0).** The once-per-device "Before you drive" notice already had the right
  moment, so its Start tap now reads the whole explanation aloud. A question mark on the drive bar
  repeats it and shows the same thing written out. Nothing holds the door announcements back while
  it plays: parked there is no heading and so nothing to collide with; moving, the next door wins.
- **Built once, for every screen.** `components/HelpButton.tsx` takes a `HelpTopic` — on-screen
  sections plus a separate spoken script, both fixed strings declared beside the screen. Drive mode
  is the only screen using it so far; rolling it out is mostly writing, and is in `docs/TODO.md`.
  Whether help should *speak by default* is a per-screen decision — at a doorstep it should not.
- **`src/speech.ts` is the one place the app talks**, and carries the rule for every caller: nothing
  from the voters list is ever spoken, because a browser may hand the text to a remote voice and that
  is the list "provided to another person" (*MEA* s. 23(8)).
- **The voice is the volunteer's choice (1.3.0).** Account → Voice, stored on the device, applied
  inside `speech.ts` so every utterance gets it. Online voices are offered but labelled and explained
  — which is only defensible because of the rule above. Anything that ever needs to speak list data
  must therefore not go through `speech.ts` at all.
- **Found on the way:** dialog footers were unstyled everywhere except the Turfs page, because
  `.modal__foot` lived in a per-page stylesheet while Messaging used the same dialog.

Proven in a headless browser with a stubbed speech engine; **not yet heard on an iPhone**, where the
user-gesture rule is respected by construction rather than by test.

- **Every screen (1.4.0, 2026-09-21).** The `?` moved into the top bar, chosen by route, with a
  topic for each of the twelve screens. It opens silently everywhere but drive mode, because the
  rest of the app is used at doorsteps and desks; "Read it aloud" is one tap away in each dialog.

### Phase 5 planned — 2026-09-06

**SMS and email to electors who opted in.** SMS is the priority channel; email is the fallback; a
person who gives only one gets that one. Nobody is messaged without an explicit yes, and STOP is
honoured before the next queued message goes out. Full plan: `docs/phase-5-messaging-plan.md`.

The two facts that shape it, both from `docs/data-sources-research.md` §2.2:

- **Canadian long codes are throttled to ~100-250 messages per day per number and the excess fails
  silently.** So there is no "text everyone" button — the sender is a drip across a pool of numbers,
  scheduled days ahead. 17,000 electors is not a deliverable audience at any price; 2,000 subscribers
  over a weekend is.
- **Campaign Verify is US-only** and from 17 Feb 2026 gates political traffic to Canada on 10DLC,
  toll-free and short codes. A Canadian municipal candidate cannot register. A local long code is the
  route, and confirming that with a provider **in writing** is step zero.

Half of it already exists: `voter_contact` carries per-purpose consent (`consent_gotv` separate from
`consent_updates`), a withdrawal that is stamped rather than deleted, and `GET /api/voter-contacts/gotv`
already returns the send list.

### Shipped since — 2026-09-07 to 09

Everything here came from the field rather than the plan, which is the point of running the tool
during the campaign it is for.

- **Deployed and public.** `https://canvass.webarchitecture.ca`, behind the pre-existing Cloudflare
  Tunnel. Not `sean-hunt.com`: a tunnel hostname must be on Cloudflare DNS, that zone is on OpenSRS
  and carries the campaign's Google Workspace MX, and moving it weeks before an election to gain a
  hostname on an internal tool is the wrong trade. README has the full reasoning.
- **A map of the lawn signs** — placed and requested together, because they are two halves of one
  driving route.
- **Turf boundaries on the main map**, scoped: a volunteer sees their own, an organiser sees all of
  them with their own drawn heavier. A turf built from streets has no boundary, so one is
  approximated from its doors and drawn dotted — a hull covers ground it cannot vouch for, and the
  map says so rather than implying coverage.
- **Open the turf you were last in**, and a drawer to switch turfs without losing your place.
- **The unreachable report**, which separates what blocks a door-knock from what only blocks the
  post. `po_box_only` is 306 doors and all of them knockable; counting it as unreachable reported
  390 blocked doors where there are 73.
- **Optional Claude-written advice** on that report (`ADVICE_API_KEY`, off by default). The second
  and last outbound call in the stack; only category codes and integers leave, with a runtime guard
  and a test asserting the payload against real elector names.
- **Field fixes.** The turf highlight was unreadable at 1,330 doors (rings merged into one black
  shape). iOS zoomed in on every form field and never zoomed back — every control computed to 15px,
  under Safari's 16px threshold — which was also what pushed the map controls off the right edge.
  "Centre on map" put the door under the sheet that asked for it. "Sync now" was a disabled no-op
  whenever the queue was empty, which reads as a broken app. A blank optional secret in `.env`
  stopped the API booting.

### Requested, not yet built — 2026-09-06

- **Notifications of events**, starting with "a turf was assigned to you" / "taken off you", and
  nudges to an organiser when a door is flagged for follow-up or a sign is requested.
- **Messages between organisers and volunteers** in the app — "can you take Ward 3 tonight?",
  "I can't finish this turf". Distinct from notifications, but a message *is* an event, so the two
  should share one delivery path rather than growing separately.

Design notes before anyone starts:

- **Web Push is the right channel and it is free.** The app already ships a service worker, and the
  "add to home screen" path landed with Phase 3 — which matters, because iOS only delivers web push
  to an *installed* PWA (16.4+). So the prerequisite is already done. No SMS provider, no per-message
  cost, no CASL exposure, because these are campaign workers with accounts rather than electors.
- **Messages between users are not voters-list data, but they will contain it.** "The man at 297
  George St was rude" is a canvasser's note about an elector sitting in a chat table. So messages
  need the same audit, retention and `make purge` treatment as everything else, and must not become
  a side channel that escapes the export rules.
- One `notification` table keyed by user with a `kind` and a jsonb payload, and a separate `message`
  table, is probably the shape — a message generates a notification, but a system event does not
  need to pretend to be a message.
- Assignment already emits an `assign_turf` audit row, so the event exists; nothing listens to it.

### Added outside the original plan

- **Lawn signs.** Not in this document at all. Place a sign from a phone with the device's GPS and its
  reported accuracy, an optional photo (magic-byte sniffed, stored on a volume rather than in the
  database), a pickup worklist of everything still standing, and a delivery list of doors whose latest
  contact ticked `wants_sign`. The driver is a by-law deadline, not canvassing: a sign nobody can find
  after election day is a fine. `db/migrations/001_signs.sql`. Since 1.5.0 an organizer can also type
  in a request that arrived by phone, text or in person, and correct or delete it. Those are
  `public_request` rows with `source: 'manual'` rather than signs, because placing a sign demands a
  GPS fix inside the municipality and a request taken over the phone has no coordinates at all.
- **Doorstep phone numbers and email addresses**, in their own `voter_contact` table with per-purpose
  consent, a recorded (never deleted) withdrawal, and an organizer-only GOTV send list. Deliberately
  separate from `voter` because it is not list data and CASL, not the Municipal Elections Act, governs
  it. `db/migrations/002_voter_contact.sql`.
- **A migration runner.** The original plan assumed `db/migrations/` existed; it did not. `db/migrate.sh`
  + `make migrate` + the `schema_migration` table now carry every change after first boot.
- **A second deployment mode, then a third host.** The plan assumed a public host with Let's Encrypt.
  The live setup is `make up-tunnel`: Caddy on `127.0.0.1:3031` behind a Cloudflare Tunnel, with
  `X-Forwarded-For` rewritten from `CF-Connecting-IP` so `audit_log` records the real client. That
  header is set, never forwarded, in **both** modes — the public `Caddyfile` overwrites it with the
  TCP peer for the same reason, since there it is the *caller* who would otherwise choose the address
  in the log. The tunnel shape now also runs on an AWS host (mode C), unchanged apart from the box.
- **Backups that leave the box.** Not in the plan beyond "backup script". `make backup-offsite` ships
  the encrypted dump and the sign-photo volume to S3 and verifies each upload; `make purge-offsite`
  destroys them afterwards and proves the bucket is empty.
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
