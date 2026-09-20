# CanvassOS

Door-knocking, voter contact and lawn-sign tracking for one municipal campaign — Sean Hunt's run for
mayor of Middlesex Centre, Ontario, election day **26 October 2026**.

It imports the municipal voters list, cuts the municipality into turfs, hands those turfs to volunteers,
records what happens at each door from a phone, and remembers where every lawn sign is so it can be
found again in November.

It runs on the campaign's own hardware, in `docker compose`. No SaaS, no third party holding the list.

![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16-336791)
![Node 22](https://img.shields.io/badge/Node-22-5FA04E)
![TypeScript 5](https://img.shields.io/badge/TypeScript-5-3178C6)
![React 18](https://img.shields.io/badge/React-18-61DAFB)
![Fastify 4](https://img.shields.io/badge/Fastify-4-000000)
![Docker Compose](https://img.shields.io/badge/deploy-docker%20compose-2496ED)

**The list, as currently loaded:**

| | |
|---|---:|
| Households | 7,140 |
| Electors | 16,892 |
| Households geocoded to a map point | 7,067 |
| Recorded by legal description (concession/lot, no civic address) | 70 |
| Addresses that would not geocode at all | 3 |
| Flagged institutions (8+ electors at one address) | 11 |
| Wards | 5 |

## Screenshots

**There are none committed, deliberately.** Every screen in this app is full of real electors' names
and addresses, and `.gitignore` blocks `web/screenshots/` for that reason.

The supported way to produce an image is the **demo stack** (`demo/seed_demo.py`), which builds a
database of entirely fabricated residents on real public street names — see
[Quick start](#quick-start-the-demo-stack). Anything captured against it can be published anywhere.

> _Placeholder — no image file exists yet._
> A real screenshot belongs at `docs/images/<screen>.png`, captured from the demo stack and from
> nothing else. `demo/shots/` and `demo/build/` are git-ignored scratch space for recording; a
> screenshot only becomes part of the repo when it is deliberately moved out of them.

## What it does

**Volunteers, on a phone.** Sign in, see the turfs assigned to you, open one, and walk the doors in
the order you pass them. Eight one-thumb result buttons; seven of them record in a single tap.
"Spoke" opens support 1–5, the sign / volunteer / ride / follow-up flags, a note, and — with consent
— a phone number or email. Record a result and the screen advances to the next unknocked door.
Volunteers see voter names at doors inside their own turfs, because you need a name to knock, and
never mailing addresses, resident status, or anything outside their turfs.

**Volunteers, in a car.** Most of this municipality is concession roads, where the next door is a
kilometre on and nobody walks it. **Drive mode** (the **Drive** link on a turf's door screen) is one
glanceable card: the next door *ahead* of the vehicle, how far, and which side of the road. It moves
on by itself as you pass, keeps the screen awake, and reads the door aloud so the phone is never
touched while the car is moving. Nearest-first is the wrong question at the wheel — the closest door
is often the one just gone by. It never speaks a name, whatever the on-screen toggle says: a voice
carries outside the car, and some phones synthesise speech on someone else's server.

**Organisers, on a laptop.** The whole municipality on a map with clustered doors, coloured by ward,
community, electors per door, record quality, non-resident owners or latest canvass result. Cut a
turf by picking streets or by drawing a polygon, with the door and elector counts updating live and
a warning when another turf already claims a street. Assign turfs, watch progress, work the
follow-up queue, search names and addresses, print a paper turf sheet.

**Lawn signs, for anyone signed in.** Place a sign from a phone with the device's GPS — the reported
accuracy is shown as prominently as the coordinate and can be re-taken before saving. Optional
photo. Coordinates outside Middlesex Centre are refused outright. Afterwards, the pickup list gives
every sign still standing with a link that opens the phone's map app.

**Admins.** Users, invite links, and the audit log.

**Website sign-ups, on their own.** People who sign up on the campaign website flow into the
Sign-ups queue automatically: a worker pulls the site's admin export every five minutes, and a
local matcher suggests which voter each one probably is — exact email/phone hits against
door-collected contact info link themselves; fuzzy name/address matches wait for an organiser's
one-click confirmation. Decisions survive voters-list re-imports, every machine action is audited,
and nothing derived from the list ever flows back out. Details:
[`docs/phase-8-subscriber-link-plan.md`](docs/phase-8-subscriber-link-plan.md).

## Why it looks the way it does

The interesting parts of this codebase are not the features. They are the four constraints the
features had to be built around.

### 1. The list is not ours to keep

The voters list is personal information supplied under Ontario's *Municipal Elections Act, 1996*
(s. 23(7)–(8)). It may be used for election purposes only, may not be passed on, and must be destroyed afterwards.
That single fact is why:

- **There is exactly one enforcement point for role-based field stripping**
  ([`api/src/lib/serialize.ts`](api/src/lib/serialize.ts)). Every voter, household and map point
  leaving the API passes through `serializeVoter` / `serializeHousehold` / `serializePointProps`,
  which are explicit **allow-lists** — they build a new object by picking keys, they never delete
  keys from a row. A column accidentally added to a SQL projection cannot leak, because nothing
  copies unknown keys through. `GET /api/households/points` goes further for volunteers and skips
  the contact join entirely, so the data is never fetched in the first place.
- **Every read of personal data writes an `audit_log` row** — logins and failed logins, household
  views, searches, invites, sign-request lists, consent changes, exports. Audit failures are logged
  and never turned into a 500; the read still succeeds and ops watch that log.
- **The service worker returns early for any URL under `/api/`**, so voter data is never written to
  the browser's Cache Storage. It precaches the app shell and nothing else — about forty lines
  generated at build time by an inline Vite plugin, rather than a workbox dependency.
- **Anything shareable runs on fabricated data.** `demo/seed_demo.py` builds a parallel database of
  invented people on real public street names, so screenshots, training and video never touch the
  list.
- **`make purge` is a first-class command**, not a note in a runbook. It drops every volume, shreds
  `data/*.csv` and the sign photos, and makes you type `PURGE`.

### 2. Rural signal is bad

Volunteers canvass concession roads where there are no bars. A write that appears to fail and is
retried must not become two knocks at the same door.

So **every write carries a client-generated idempotency key**. `contact.client_id` and
`sign.client_id` are `UNIQUE`; the insert is `ON CONFLICT (client_id) DO NOTHING` plus a re-select
in one transaction, and a replay returns `200` with the stored row instead of `201` and a duplicate.
It is not audited twice either. That seam is what the offline queue drains into: results recorded with
no signal wait on the phone and replay when it comes back, and a replay cannot double-count.

And when the phone dies entirely, there is a **printable turf sheet** — doors in walking order, on
paper, in a pocket.

### 3. The geocoding was hard, and the original pipeline was lost

The clerk's list is four columns of text: name, property address, mailing address, ward. Turning
that into 7,067 map points meant parsing civic addresses out of free text and matching them against
Middlesex County's open address points, across two files that spell street types differently
(`AVE`/`AVENUE`/`AV`, `CRT`/`COURT`/`CT`) and one village whose Delaware Street runs North, Central
and South.

The original pipeline that produced the importer's inputs was not kept.
[`pipeline/build_lists.py`](pipeline/build_lists.py) is a reconstruction from the same raw sources,
and it documents its own accuracy rather than claiming to be the original — see
[Rebuilding the importer's inputs](#rebuilding-the-importers-inputs). It reproduces the original's
published figures exactly for electors, legal descriptions, institutions, duplicates and
`resident_class = unknown`. `resident_class` itself differs materially, and the difference is
written down instead of smoothed over.

### 4. Contact details from the door are a different kind of data

The clerk's list carries no phone numbers and no email addresses. Anything the campaign has was
handed over by a person standing at their own door, for a purpose they were told about. So it lives
in a **separate table** (`voter_contact`, [`db/migrations/002_voter_contact.sql`](db/migrations/002_voter_contact.sql)),
never as columns on `voter`:

- **Consent is per purpose** — `consent_gotv` and `consent_updates` are separate columns, because a
  single "ok to contact" flag cannot answer "did they agree to *this*?". A value offered with
  neither is refused with `400 consent_required`.
- **Withdrawal is recorded, not deleted.** The row stays with `withdrawn_at` stamped. A deleted row
  would simply be collected again at the next canvass; the point is to remember that somebody asked
  us to stop. Re-offering a number never quietly clears a withdrawal.
- The audit `detail` for these routes **never contains the value itself**, or `audit_log` would
  become a second, un-withdrawable copy of every number the campaign was ever given.

Canada's Anti-Spam Legislation governs the messages this feeds. Recording *what* was agreed, *when*,
and *who* took it is what makes the consent defensible if it is ever questioned.

## Architecture

```mermaid
flowchart LR
    B["Browser / PWA<br/>React 18 · MapLibre GL<br/>service worker: app shell only"]

    subgraph compose["docker compose — project 'canvass'"]
        direction TB
        CA["<b>caddy</b><br/>TLS, static SPA, /api proxy"]
        API["<b>api</b><br/>Fastify 4 + TypeScript<br/>internal :3000"]
        DB[("<b>db</b><br/>postgis/postgis:16-3.4<br/>volume: pgdata")]
        IMP["<b>importer</b><br/>one-shot Python<br/>compose profile: import"]
    end

    CSV["data/voters_final.csv<br/>data/households.csv<br/>(git-ignored, mounted read-only)"]

    B -- "https" --> CA
    CA -- "try_files → /srv (webroot volume)" --> B
    CA -- "reverse_proxy api:3000" --> API
    API -- "pg pool" --> DB
    CSV --> IMP -- "one transaction, then exits" --> DB
```

Five services. Only Caddy publishes ports; the API is `expose`d on the compose network and the
database has no host mapping at all. A fifth service, `web`, is **build-only**: it builds the SPA,
copies `/app/dist` into the shared `webroot` volume and exits, and Caddy waits on it with
`service_completed_successfully`. There is no nginx anywhere.

Basemap tiles come straight from public OSM / CARTO / Esri endpoints and never pass through the
stack; map glyphs are self-hosted so no font request leaves the origin.

| Layer | Choice | Note |
|---|---|---|
| Proxy / TLS | Caddy 2 | Let's Encrypt for `$DOMAIN`, or plain HTTP behind a Cloudflare Tunnel |
| Database | PostgreSQL 16 (PostGIS image) | `lat`/`lon` columns, not a geometry type — see below |
| API | Fastify 4, TypeScript, ESM, `pg`, `zod`, argon2id | No ORM; SQL lives in the route |
| Web | Vite 5, React 18, react-router 6, TanStack Query, MapLibre GL 5 | MapLibre is lazy-loaded and manually chunked |
| Importer | Python 3.12 + `psycopg` | One file, one transaction, idempotent by sha256 |

**Why `lat`/`lon` and not PostGIS geometry.** The production image *is* `postgis/postgis:16-3.4`,
but the schema stores two `double precision` columns so it also runs on a bare PostgreSQL 16 in
development. Nothing needs spatial operators yet: the map query is a bbox `BETWEEN` on indexed
columns, and turf polygons are point-in-polygon'd in [`api/src/lib/geo.ts`](api/src/lib/geo.ts) with
the same ray cast the turf-builder preview uses in the browser — so the preview cannot promise a
different turf from the one that gets saved.

Deeper detail — the request lifecycle, the session cookie, the error envelope, the full data model —
is in [`docs/README.md`](docs/README.md). The endpoint and role contract is
[`API.md`](API.md), and it is authoritative.

## Quick start: the demo stack

Start here if you have no voters list, which is everyone but the campaign. Fabricated residents,
real public street names, safe to screenshot.

Prerequisites: Docker with compose v2, Node 22, Python 3.12 with `pip install 'psycopg[binary]'`.

```bash
git clone https://github.com/smhunt/CanvassOS && cd CanvassOS
cp .env.example .env && $EDITOR .env      # any values will do for a demo

make devdb                                # stack + Postgres published on 127.0.0.1:5443

# a second, fabricated database alongside the real one
docker compose exec -T db psql -U canvass -d postgres -c 'CREATE DATABASE canvass_demo'
docker compose exec -T db psql -U canvass -d canvass_demo < db/schema.sql
PSQL="docker compose exec -T db psql -U canvass -d canvass_demo" ./db/migrate.sh
python3 demo/seed_demo.py --database-url postgresql://canvass:<POSTGRES_PASSWORD>@localhost:5443/canvass_demo

# API on 3132, web on 3032 — see .env.demo for the rest of the environment
cd api && npm install && env $(grep -v '^#' ../.env.demo | xargs) npm run dev
cd web && npm install && CANVASS_WEB_PORT=3032 CANVASS_API_PORT=3132 npm run dev
```

Then open **https://dev.ecoworks.ca:3032** and sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD`
from `.env.demo`. `seed_demo.py` is deterministic (`Random(20261026)`) and refuses to run against a
database that already has households, so the demo is the same every time.

## Deploying for real

Three shapes, but only two Caddy configurations: B and C are the same tunnel setup on different
hardware, and differ in the host, not the stack. All three start from `cp .env.example .env`, which
wants `DOMAIN`, `POSTGRES_PASSWORD`, `SESSION_SECRET` (`openssl rand -base64 48`), `ADMIN_EMAIL`,
`ADMIN_PASSWORD` (≥ 10 chars) and `BACKUP_PASSPHRASE` — plus `BACKUP_S3_URI` if the backups are to
leave the box (see "Backups and restore").

<details>
<summary><b>A. Public Docker host (Ubuntu VM or VPS) — Caddy gets its own certificate</b></summary>

Prerequisites: Ubuntu 22.04/24.04, Docker Engine + compose v2 (`docker compose version`), `make`,
`gpg`. A public DNS **A record** `$DOMAIN → <server IP>` and inbound **ports 80 and 443** open —
Caddy obtains and renews the Let's Encrypt certificate itself, and port 80 is needed for the ACME
challenge and the HTTP→HTTPS redirect.

```bash
git clone <repo> canvass && cd canvass
cp .env.example .env && $EDITOR .env
make up                       # builds api + web, starts db → api → web(build) → caddy
make logs SERVICE=caddy       # wait for "certificate obtained"
```

**Client IPs.** Caddy is internet-facing in this mode, so `Caddyfile` **overwrites**
`X-Forwarded-For` with the TCP peer rather than appending to whatever the caller sent — a
single-valued `header_up` replaces the header. Without that, a caller could choose the address
recorded in `audit_log` (the Municipal Elections Act artefact) and the address the login rate limiter
keys on. If a CDN is ever put in front of this mode, switch that line to the `CF-Connecting-IP` form
`Caddyfile.tunnel` uses, or the log will faithfully record the CDN's edge address for every request.
</details>

<details>
<summary><b>B. Cloudflare Tunnel on the office Mac — the current setup</b></summary>

The campaign runs the stack on the office Mac and publishes it through a Cloudflare Tunnel, so no
router port-forward is needed and the home IP is never exposed. TLS terminates at the Cloudflare
edge; Caddy therefore serves plain HTTP on `127.0.0.1:3031` and nothing binds a public port.

```bash
make up-tunnel      # same stack as `make up`, but Caddy → 127.0.0.1:3031, no 80/443, no Let's Encrypt
make tunnel-status  # is the origin answering?
```

`docker-compose.tunnel.yml` overlays the base compose file and swaps in `Caddyfile.tunnel`.

**Client IPs.** `Caddyfile.tunnel` rewrites `X-Forwarded-For` from `CF-Connecting-IP` before
proxying to the API. Without it every `audit_log` row would record the tunnel's own address, which
would defeat the point of the log under the Municipal Elections Act.

**DNS — what is actually deployed.** The stack is live at **`https://canvass.webarchitecture.ca`**,
not on `sean-hunt.com`. That was a deliberate choice, and the reasoning matters if you change it:

- A Cloudflare Tunnel hostname **must** be served by Cloudflare DNS. `cloudflared tunnel route dns`
  creates a CNAME to `<UUID>.cfargotunnel.com`, and that target only resolves inside Cloudflare's
  network — creating it at another registrar looks right in the panel and silently fails.
- `sean-hunt.com` is on OpenSRS nameservers (`ns1/2/3.systemdns.com`) and carries the campaign's
  **Google Workspace MX records**. Moving the zone to Cloudflare to get a tunnel hostname puts
  campaign email in the blast radius, weeks out from an election.
- `webarchitecture.ca` is already on Cloudflare, so the app got a hostname there in minutes with no
  DNS risk at all. This is an internal tool for volunteers, not a public campaign page, so the
  hostname carries no brand weight.

The live setup:

```bash
cloudflared tunnel login                    # browser OAuth, writes ~/.cloudflared/cert.pem
# ingress in ~/.cloudflared/config.yml, above the http_status:404 catch-all:
#   - hostname: canvass.webarchitecture.ca
#     service: http://localhost:3031
cloudflared tunnel route dns <UUID> canvass.webarchitecture.ca
```

`DOMAIN` in `.env` must match the hostname — invite and password-reset links are built from it
(`api/src/routes/users.ts`). Changing the hostname invalidates every invite link already sent.

**Keeping it up across reboots.** Homebrew's `cloudflared` service is a trap: its plist runs the
binary with **no arguments**, so `brew services start cloudflared` prints help and exits without
ever running a tunnel. Use a LaunchAgent with the real command —
`~/Library/LaunchAgents/ca.webarchitecture.canvass-tunnel.plist`, `RunAtLoad` + `KeepAlive`, running
`cloudflared --config ~/.cloudflared/config.yml tunnel run`. It is a *user* agent, so it starts at
login; a machine that reboots to a login screen and sits there stays down until someone logs in.
`sudo cloudflared service install` is the root-level alternative.

**To move it to `canvass.sean-hunt.com` later**, either delegate just the subdomain to Cloudflare
(add the `canvass` NS records at OpenSRS, leaving the apex, `www` and MX untouched), or point an A
record at the host's IP, forward ports 80/443, and use plain `make up` so Caddy gets its own Let's
Encrypt cert.

**Operational caveats of hosting on the Mac:** the app is unreachable whenever the machine sleeps or
leaves the network, and the voters list lives on that disk — so keep FileVault on, keep `make backup`
running, and remember `make purge` after 26 October 2026.
</details>

<details>
<summary><b>C. AWS EC2 behind the Cloudflare Tunnel — the same stack, off the Mac</b></summary>

Mode B's operational caveats are the reason this exists: a machine that sleeps, leaves the network or
reboots to a login screen takes the canvass down mid-shift. Mode C is **the same `make up-tunnel`
stack and the same `Caddyfile.tunnel`**, on a host that stays up, publishing the same
`canvass.webarchitecture.ca` through the same kind of dedicated tunnel. Nothing in the compose files,
the Caddy config or `TRUST_PROXY` changes — there is still exactly one proxy in front of the API.

| | |
|---|---|
| Instance | `t3.medium`, **x86_64** — see the landmine below, this is not a preference |
| OS | Ubuntu 24.04 LTS |
| Region | **ca-central-1**, so Ontario electors' personal information stays in Canada |
| Root volume | 30 GiB gp3, **encrypted**, `DeleteOnTermination=true` — the disk dies with the instance |
| Security group | **no inbound rules at all**. The tunnel dials out; nothing needs to reach in |
| Administration | **SSM Session Manager**, not SSH — no key to lose, no port 22 to leave open |
| Backups | S3 in the same region, GPG-encrypted before upload — see "Backups and restore" |
| Tags | `Project=canvass-2026` on every resource |

**It must be x86_64. Do not "optimise" this to Graviton.** `postgis/postgis` publishes **no arm64
image on any tag** — 16-3.4, 16-3.4-alpine, 16-3.5, 16-3.5-alpine and 17-3.5 are all amd64-only —
so on a `t4g.*` the `db` container crash-loops at boot. It works on an Apple Silicon Mac only because
Docker Desktop emulates amd64 through Rosetta, which is exactly the kind of local success that makes
this look like a shrug. Nor is plain `postgres:16` a drop-in substitute: a `pg_dump` taken from the
PostGIS image carries `COMMENT ON EXTENSION postgis` statements, and `make restore` runs `psql -v
ON_ERROR_STOP=1`, so the restore aborts. **Restore into the same image the dump came from.**

```bash
# on the instance, over SSM
git clone <repo> /srv/canvass && cd /srv/canvass
cp .env.example .env && $EDITOR .env      # DOMAIN=canvass.webarchitecture.ca, BACKUP_S3_URI=…
make up-tunnel
make tunnel-status                        # is the loopback origin answering?
```

`cloudflared` runs as a systemd unit rather than a LaunchAgent: config and credentials live in
`/etc/cloudflared/` (see [`deploy/cloudflared-canvass.yml`](deploy/cloudflared-canvass.yml)),
installed with `sudo cloudflared --config /etc/cloudflared/canvass.yml service install` and enabled
with `systemctl enable --now cloudflared`. That is the advantage over a LaunchAgent: a system service
starts at boot, with nobody logged in.

**The S3 bucket** is in `ca-central-1` alongside the instance, with Block Public Access on, a
TLS-only bucket policy, versioning **off** and a 30-day lifecycle rule. The instance role can write
and `head-object` but deliberately **cannot delete**, so a compromised box cannot destroy the only
off-site copies. **Never enable Object Lock on it**: retention that cannot be shortened would make
the legally required post-election purge impossible until it expired.

**Everything carries `Project=canvass-2026`** because this AWS account is shared with unrelated
workloads — "close the account" is not available as the destruction artefact, so the tag is what lets
the purge enumerate what must go. See "Purge, after the election".

`docker-compose.devdb.yml` still never belongs on this host: it publishes Postgres on a host port.
</details>

### Cutting production over to AWS

`scripts/cutover-aws.sh` moves production from the office Mac to the EC2 box — and back. Run it on the
Mac, from the repo root; it drives EC2 over `ssh canvass-prod`.

```bash
./scripts/cutover-aws.sh preflight   # read-only checks on both machines — safe at any time
./scripts/cutover-aws.sh prepare     # no production impact: refresh EC2's code, rebuild it, empty its database
./scripts/cutover-aws.sh cutover     # THE WINDOW, ~15 min: freeze, dump, restore, compare, switch the tunnel
./scripts/cutover-aws.sh finish      # once checked on a phone: the Mac can no longer resume by accident
./scripts/cutover-aws.sh rollback    # back onto the Mac  (--with-data once AWS has taken real writes)
```

It exists to get four things right, each of which loses data quietly:

- **Split brain.** Two `cloudflared` connectors on one tunnel are load-balanced, not failed over. EC2's
  connector starts only after `cloudflared tunnel info` shows *zero* connectors — never on a timer.
- **The freeze stops every writer, not just the tunnel.** The Mac's API container runs the subscriber
  sync every five minutes and writes with no request at all, and a dev API on `:3130` may be
  connected to the same database. Both are stopped, or the dump and the baseline drift apart.
- **A 4xx in the window is worse than an outage.** The phone outbox retries a dead host or a 5xx for
  about seventy minutes but *parks* an entry on any other 4xx. EC2 is never reachable on the real
  hostname until its row counts match.
- **The gate is a diff.** Exact per-table counts from both databases, taken while both are
  quiescent — EC2's API stays stopped until after the comparison — and any difference aborts.

`cutover` leaves `backups/cutover-<stamp>.log`, `.mac.counts` and `.ec2.counts` as the record of the
move. `finish` deletes the production tunnel credentials from the Mac on purpose; EC2 keeps its copy
and `rollback` fetches them back from there.

### Loading the list

Copy the two pipeline outputs to `data/` (they are git-ignored) and load them:

```bash
scp voters_final.csv households.csv server:canvass/data/
make import LABEL="voters list export 2026-09-03"
```

The importer prints the `hh_flag` values it saw, per-ward and per-community counts, legal and
institution counts, and verifies every total after loading — a mismatch rolls the whole transaction
back. It refuses to run twice on identical files (sha256 recorded in `import_run`).

### Taking a newer list without losing canvass work

When the clerk issues a corrected or updated list, **do not use `make import-force`**. It replaces the
list with `TRUNCATE household CASCADE`, which also deletes every canvass result, lawn sign, sign photo
row, doorstep consent record, turf membership and website sign-up. Use the diff:

```bash
make backup                                               # always, first
make import-diff  LABEL="voters list export 2026-10-02"   # dry run: prints the change, writes nothing
make import-apply LABEL="voters list export 2026-10-02"   # makes exactly that change, in one transaction
```

The dry run reports households and voters matched, new, removed-and-deleted and removed-but-kept; how
many doors the new export renumbered; how many new houses needed a fresh id; and likely moves.

What the apply guarantees, and why:

- **Canvass work stays on the same door.** The pipeline numbers households sequentially in sort order,
  so one new house renumbers every door after it. The diff never matches on that id. It matches on the
  pipeline's own address key, and a matched door keeps its database id whatever the new export called it.
- **Nothing that references the list is deleted.** A voter or household that has left the list but is
  cited by a contact, sign, consent record, turf or sign-up is kept, and still counts in totals until
  someone deals with it. Before committing, the apply counts every contact, sign, photo, consent record,
  turf membership and sign-up, and **rolls the whole transaction back if any of those numbers went down**.
- **No household id is ever reused**, because `audit_log` records household ids as text and a reused
  id would silently change what past audit rows are about.
- **A person at a new address is reported as a possible move, never linked.** Nothing on the list says
  it is the same person.
- **A voter whose address only changed spelling** ("ST." to "ST") is re-keyed rather than replaced, and
  the website subscriber ledger follows them to the new key.

The planner is `importer/diff.py`, pure and unit-tested (`cd importer && python3 -m pytest -q
test_diff.py`). `importer/test_apply_integration.py` applies a deliberately awkward changed list to a
throwaway copy of `canvass_test` and checks that every seeded contact, sign, consent record and turf
membership is still at the same street address:

```bash
cd importer
CANVASS_TEST_DESTRUCTIVE=1 \
IMPORT_TEST_ADMIN_URL=postgresql://canvass:$POSTGRES_PASSWORD@localhost:5443/postgres \
  python3 -m pytest -q test_apply_integration.py
```

### First login and inviting people

Browse to `https://canvass.webarchitecture.ca` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. The
admin account is created **only on first boot when no users exist**; after that the two variables are
ignored and can be removed from `.env`. **Change the password immediately** (account menu → change
password). Changing it also logs out every other session.

Admin → Users → Invite: email, name, role. The API returns an `invite_url`
(`https://$DOMAIN/invite/<token>`, valid 7 days, single use). There is no email service — send the
link yourself. "Re-invite" issues a fresh link and doubles as a password reset. Deactivating a user
ends their sessions; the last active admin cannot be deactivated or demoted.

| Role | Sees |
|---|---|
| `volunteer` | Their assigned turfs: the door screen with voter names, the map, lawn signs. No mailing addresses, no resident status, no municipality-wide search, nothing outside their turfs. |
| `organizer` | Everything above plus household cards with mailing details, search, streets, stats, turf building and assignment, reports, the legal-description list. |
| `admin` | Organiser plus user management, invites and the audit log. |

The client-side role gates in `web/src/auth.tsx` are navigation sugar. **The API is the boundary.**

### Printing a turf sheet

Open a turf and choose **Print sheet** (or go straight to `/turfs/<turf-id>/sheet`), then **Print this
sheet**. Portrait, one-sided, A4 or Letter — both fit without scaling, about 12 doors to a page. It
lists every door in walking order with the residents' names, tick boxes for Spoke / Not home /
Refused / Literature, a 1-5 support scale to ring and space for a note. It is the fallback for a dead
battery, no signal or rain, and it prints fine in black and white.

**Handling the paper.** It comes from the voters' list under the *Municipal Elections Act*: election
use only. Do not photocopy it, do not post or share it, do not leave it in a vehicle. Enter the
results in the app when you get back, then hand the sheet to your organiser or shred it. That rule is
printed on every page of the sheet itself, next to a line for who entered it.

### Installing it on a phone

Volunteers should add CanvassOS to the home screen — it opens full screen and starts faster at the
door. On Android/Chrome the app offers an **Add** button; on **iPhone and iPad, tap Share, then "Add
to Home Screen"** (Safari has no install button, so the app shows those instructions instead). Either
way it asks once: dismiss it and it stays dismissed on that phone.

## Municipal Elections Act — handling the voters list

The voters list is personal information supplied under the Ontario *Municipal Elections Act, 1996*.
The operative provision is **s. 23(7)–(8)**: the clerk gives a copy to a candidate, and everyone the
candidate then gives it to *"shall not provide it to any other person, and shall not make further
copies, either in printed form or electronically"*. Ontario's
[2026 Candidates' Guide](https://www.ontario.ca/document/2026-candidates-guide-ontario-municipal-council-and-school-board-elections/voters-list)
puts it plainly: use it *"only for electoral purposes, not for commercial purposes"*.
(This is a reading of the statute, not legal advice — confirm the details with the clerk.)

Everyone with an account must understand:

- **Election purposes only.** The list may be used only for the purposes of this election campaign,
  and may not be passed on. Phone numbers and emails collected at the door are a different thing
  entirely, governed by the consent actually given for them, and must never be merged back into an
  export of the list.
- **No merging is this campaign's own rule, not the Act's.** A search of the Act and O. Reg. 101/97
  turns up no provision forbidding enrichment of list-derived records. We do not do it anyway,
  because the electors never agreed to it — but it should be described as a policy we chose, not a
  law we are obeying.
- **Access is logged.** Every login, household card view, search, invite, consent change and export
  is written to `audit_log` (admin: `GET /api/audit`). Volunteers never receive mailing addresses or
  resident status, and see only doors inside the turfs assigned to them.
- **Keep it secure.** TLS only, login required for every page, strong passwords (min 10 chars),
  encrypted backups, no copies of the CSVs on laptops or phones once imported. Sign photos show
  people's houses, so they are served only to an authenticated session and are destroyed with
  everything else.
- **Destroy after the election.** After 26 October 2026 (and after any recount or compliance period
  the clerk indicates): `make purge` on the server, delete `backups/*.gpg` and any off-site copies,
  and delete the pipeline outputs (`voters_final.csv`, `households.csv`, `.xlsx`). Keep a note of
  the date it was done.
- **Collect written acknowledgements — the software cannot do this for you.** Under s. 23(8) anyone
  the campaign gave an electronic copy to must destroy it and give the candidate *written
  acknowledgement* that they have, and the candidate keeps those acknowledgements until **15 November
  2030**. That includes anyone who was sent a CSV, a printed turf sheet they did not return, or a
  database dump. `make purge` wipes this server; it cannot reach a volunteer's laptop, a phone's
  cached turf, or a sheet left in a glovebox. Keep a list of who received what, and collect the
  acknowledgements.

In-app, the same notice appears in the footer, on the account page and on the audit page.

## Operating it

```bash
make ps / make logs [SERVICE=api]   # status, logs
make restart                        # after editing .env (rebuilds api/web images)
make psql                           # psql inside the db container
make down                           # stop; data stays in the pgdata volume
make help                           # every target, with its one-line description
```

<details>
<summary><b>Database migrations</b></summary>

`db/schema.sql` is applied **only to an empty database**, by the postgres image on first boot. Once
a stack carries real data, every schema change arrives as a file in `db/migrations/` instead:

```bash
make migrate-status   # what is applied, what is pending
make migrate          # apply pending migrations, each in its own transaction
```

Applied migrations are recorded in `schema_migration`; the migration and its bookkeeping row commit
together, so a failure leaves nothing half-applied. Migrations run in filename order — prefix new
ones with the next number. Remember to run them against `canvass_test` too:

```bash
PSQL="docker compose exec -T db psql -U canvass -d canvass_test" ./db/migrate.sh
```

**Never edit `db/schema.sql` to change a live stack.** It will not re-run, and the two silently
diverge.
</details>

<details>
<summary><b>Backups and restore</b></summary>

`make backup` runs `pg_dump | gzip | gpg --symmetric --cipher-algo AES256` with `BACKUP_PASSPHRASE`
from `.env` and writes `backups/canvass-<timestamp>.sql.gz.gpg`. It is useless without the
passphrase, so keep the passphrase somewhere other than the server.

**`make backup-offsite` is the one to schedule.** `backups/` sits on the same disk as the database,
so until the file leaves the host there is no copy that survives losing the box.
[`scripts/backup-offsite.sh`](scripts/backup-offsite.sh) runs `make backup`, uploads the dump to
`$BACKUP_S3_URI/db/` and then **verifies it with `aws s3api head-object`** rather than trusting the
exit code — an upload that silently did nothing is the failure mode that leaves you believing you
have backups you do not have. It also tars and encrypts the `signphotos` volume to
`$BACKUP_S3_URI/photos/`, because `pg_dump` does not cover it: the moment a volunteer uploads one
photograph of an elector's house, a database-only backup is quietly incomplete. Empty volume, no
tarball, so a 45-day campaign does not accumulate 45 identical empty ones. Finally it prunes local
`*.gpg` older than 14 days. Everything is encrypted **before** it leaves the host, so the bucket
never holds plaintext personal information.

```
30 3 * * * cd /srv/canvass && ./scripts/backup-offsite.sh >> /var/log/canvass-backup.log 2>&1
```

Bucket design and the rule against Object Lock are in "C. AWS EC2 behind the Cloudflare Tunnel"
above. On EC2 the instance role supplies the credentials; from a workstation, set `AWS_PROFILE`.

Restore onto a fresh stack: `make up` (or `make up-tunnel`), then
`make restore FILE=backups/canvass-<timestamp>.sql.gz.gpg` (the dump carries `--clean --if-exists`,
so it replaces the empty schema created on first boot). **Restore into the same database image the
dump came from**: a dump taken from `postgis/postgis` carries `COMMENT ON EXTENSION postgis`
statements, and `make restore` runs `psql -v ON_ERROR_STOP=1`, so feeding it to a plain `postgres:16`
aborts partway through.

**Test the restore, not the backup.** A file in a bucket proves an upload happened; it does not prove
the dump inside it is loadable. Restore one into a throwaway database and count the households.

**A caveat about `make`.** macOS ships **GNU Make 3.81**, and `.ONESHELL:` — which this Makefile
declares — arrived in **3.82**. On the Mac it is therefore silently ignored and every recipe line
runs in its own shell. That is not academic: it is why `backup` and `restore` would have encrypted
and decrypted with an **empty** passphrase (`$$PASS` was set in one shell and read in another) and
why `set -o pipefail` never reached the `pg_dump | gzip | gpg` pipeline, so a failed dump was masked
by a successful `gzip` and still exited 0. Nothing was actually lost only because no backup had ever
been taken — `backups/` did not exist. Both are now single commands joined with
backslashes. **Any new multi-line recipe must be written the same way**, whatever `.ONESHELL:` at the
top of the file appears to promise. `make --version` tells you which one you are on.
</details>

<details>
<summary><b>Re-importing a newer list</b></summary>

The importer is idempotent on identical files. Different files replace `household` and `voter`
inside one transaction.

**Current limitation:** if canvass `contact` rows exist, the importer refuses (exit 2), because
replacing the list would orphan them. `make import-force` replaces the list *and deletes all
contacts*. Phase 4 adds a diff-based re-import (new / removed / moved electors, matched on
`voter.natural_key`) that preserves contacts.
</details>

<details>
<summary><b>Purge, after the election</b></summary>

```bash
make backup                 # optional final encrypted archive, if the campaign must retain one briefly
AWS_PROFILE=<admin> make purge   # type PURGE: stops the stack, deletes the db/web/caddy/photo
                            # volumes, shreds data/*.csv and data/sign-photos, then destroys the
                            # off-site backups and proves the bucket is empty
rm -f backups/*.gpg         # local archives, including the one just taken
```

**`make purge` now calls `make purge-offsite CONFIRM=PURGE` itself**, and that step deliberately
cannot succeed with the instance role: it has no `s3:DeleteObject`, because a compromised box must
not be able to destroy the only off-site copies. So running `make purge` on the EC2 host fails
loudly at the last step, *after* the local destruction has already happened. Either run the whole
thing with admin credentials (`AWS_PROFILE=<admin> make purge`) or run `make purge-offsite` from a
workstation first. It does not stop at `s3 rm`: it re-lists the prefix afterwards and exits non-zero
if anything is still there, because "the delete command ran" is not evidence under the Act.

On AWS, the volumes are only part of it. Work the tag:

```bash
aws resourcegroupstaggingapi get-resources \
  --tag-filters Key=Project,Values=canvass-2026 --region ca-central-1
```

Terminate the instance (`DeleteOnTermination` takes the encrypted EBS volume with it), delete the
bucket, release the Elastic IP, revoke the IAM role, and confirm no snapshots or AMIs were left
behind. The account is shared with unrelated workloads, so closing it is not available as the
destruction artefact — the tag query returning nothing is.
</details>

## Development

```bash
cd api && npm install
DATABASE_URL=postgresql://canvass:canvass@localhost:5443/canvass SESSION_SECRET=$(openssl rand -hex 32) \
  DOMAIN=localhost ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=dev-password-1 COOKIE_SECURE=false PORT=3130 \
  npm run dev                        # tsx watch; http://localhost:3130/api/health
npm run typecheck                    # tsc --noEmit

cd web && npm install
npm run dev                          # https://dev.ecoworks.ca:3030 — /api proxied to the API on 3130
npm run build && npm run preview     # https://dev.ecoworks.ca:4173 (what tools/e2e.py drives)
```

A test database can be plain Postgres 16 with `db/schema.sql` applied (`psql -f db/schema.sql`;
reset with `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`), then the migrations in
`db/migrations/`. To load it from CSVs directly:

```bash
pip install 'psycopg[binary]'
python3 importer/import.py --voters data/voters_final.csv --households data/households.csv \
    --label "voters list export 2026-09-03" \
    --database-url postgresql://canvass:canvass@localhost:5443/canvass
```

### Dev ports

Registered in `~/.claude/PORTS.md`; production is unaffected (Caddy owns 80/443 and the API stays on
its internal 3000).

| Service | Port | URL |
|---------|------|-----|
| Web (Vite dev) | 3030 | https://dev.ecoworks.ca:3030 |
| Web (Vite preview) | 4173 | https://dev.ecoworks.ca:4173 |
| API | 3130 | http://localhost:3130 |
| Postgres | 5443 | `postgresql://canvass:canvass@localhost:5443/canvass` |
| Demo web / demo API | 3032 / 3132 | https://dev.ecoworks.ca:3032 |

The Vite dev and preview servers serve HTTPS using the shared mkcert cert at
`~/Code/.traefik/certs/{cert,key}.pem`, falling back to plain HTTP if it is missing. Because dev is
TLS, the session cookie keeps its `Secure` flag end to end — `COOKIE_SECURE=false` is only needed if
you hit the API directly over plain HTTP rather than through the Vite proxy.

API env: `DATABASE_URL`, `SESSION_SECRET` (≥ 32 chars), `DOMAIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`PORT` (3000), `TRUST_PROXY` (1 — a **hop count**, not a flag: the number of proxies nearest the
server that may be believed, which is one Caddy in every mode. `true` would trust every hop and so
return the left-most, caller-supplied `X-Forwarded-For` entry, and `req.ip` is what `audit_log.ip`
and the login rate limiter are built on), `COOKIE_SECURE` (true; `false` for plain-HTTP dev),
`BOUNDARY_PATH` (`../data/mc_boundary.json`; compose mounts it at `/data/mc_boundary.json`),
`SIGN_PHOTO_DIR` (compose sets the `signphotos` volume; locally defaults to `./data/sign-photos`),
`LOG_LEVEL`.

### Running the tests

The API suite writes to the database it is pointed at, so it **refuses to run** unless you opt in
*and* point it somewhere disposable. It will not touch a database named `canvass`:

```bash
# one-off: a throwaway copy of the live database (instant, and it carries the imported list)
docker compose exec -T db psql -U canvass -d postgres -c 'CREATE DATABASE canvass_test'
docker compose exec -T db bash -c 'pg_dump -U canvass canvass | psql -U canvass canvass_test'

cd api
CANVASS_TEST_DESTRUCTIVE=1 \
  TEST_DATABASE_URL=postgresql://canvass:$POSTGRES_PASSWORD@localhost:5443/canvass_test \
  npm test
```

It is an integration suite: it derives expected counts from `../data/*.csv`, creates users named
`<who>+<run id>@test.local`, and deletes exactly the rows it created. That rule exists because the
suite once truncated `app_user` / `session` / `audit_log` and wiped the admin account and audit log
of a running system. Keep it. The suite is also the regression net for the role rules — it asserts
that volunteer responses carry none of `mailing_address`, `mail_city`, `mail_postal`,
`resident_class`, `n_nonresident`, `n_po_box`.

The web package has a much smaller, safe one — pure maths, no database, no DOM, no network:

```bash
cd web && npm test      # tsx --test src/canvass/*.test.ts: bearings and drive mode's door selection
```

<details>
<summary><b>web/Dockerfile contract — easy to break, so read before touching that image</b></summary>

`docker-compose.yml` treats `web` as a **build-only** stage: it runs
`sh -c "rm -rf /srv/* && cp -r /app/dist/. /srv/"` with the named volume `webroot` mounted at
`/srv`, then exits; Caddy starts after it completes and serves `/srv` with
`try_files {path} /index.html`.

Therefore **`web/Dockerfile` must produce the production build at `/app/dist`** (the Vite default
when `WORKDIR /app`) and its final image must contain `sh`, `rm` and `cp` — any `node:*-alpine` or
`alpine` base does; never `scratch` or an nginx image. The SPA calls the API at the same origin
under `/api/*` and must route `/invite/<token>` to the accept-invite screen. No nginx: Caddy serves
the files.
</details>

## Rebuilding the importer's inputs

[`pipeline/build_lists.py`](pipeline/build_lists.py) produces `data/voters_final.csv` and
`data/households.csv` from the two raw sources — the clerk's list and the county's open address
points:

```bash
pip install openpyxl
python3 pipeline/build_lists.py \
    --xlsx ../election-website-2026/voter-data/voter-data-sep3.xlsx \
    --addresses ../election-website-2026/voter-data/Address.geojson \
    --out-dir data
```

It parses names and civic addresses, geocodes each door against the 8,016 Middlesex Centre address
points, groups electors into households, classifies residency, and prints a summary to check against
the numbers below. The outputs are git-ignored and are shredded by `make purge`.

**This is a reconstruction.** The original pipeline was not kept, so the derived columns are produced
by the rules documented in the script rather than recovered. It reproduces the original's published
figures exactly for electors (16,892), legal descriptions (70), institutions (11), duplicate list
entries (2) and `resident_class = unknown` (4), and lands one household high — 7,140 against the
original's 7,139.

`resident_class` is the one column that differs materially: this version counts **390**
non-residents where the original counted 337. An elector is treated as resident when their mail
arrives at the property itself, in a Middlesex Centre community, or at another address that
geocodes inside the municipality; anything else is non-resident. The original's rule is unknown, so
**treat the non-resident layer as indicative and confirm at the door** before relying on it.

Three addresses still fail to geocode (`record_quality = check`) and have no map point.

<details>
<summary><b>Importer field mapping</b></summary>

`households.csv` → `household`: `address = address_clean`, `property_address_raw = property_address`,
`civic_num/street/street_type/street_dir/unit = num/street/type/dir/unit`, `is_legal = household_id`
starts with `H-LEGAL` or `addr_match == 'legal'`, `is_institution = 'institution' in hh_flag` (the
only non-empty `hh_flag` values are `legal description, no civic address` and
`large (8+ voters at one address, likely multi-unit / institution without unit numbers)`),
`n_po_box = n_mail_po_box`, `street_sort = street type dir` (space-joined, trimmed), `num_sort` =
leading integer of `num` (`122 1/2` → 122; NULL for legal rows).

`voters_final.csv` → `voter`: `last_name = last_name_clean`,
`name_raw = last_name || ', ' || first_names` (raw list columns),
`natural_key = lower(last_name) || ', ' || lower(first_names) || '|' || property_address`.

The list contains two people listed twice at the same property (`LORENC, JAYNE F` at 119 KING ST and
`EMPSON, TANYA L` at 22893 HIGHBURY AVE N). Because `natural_key` is UNIQUE, the second occurrence
gets a `#2` suffix and both rows are kept, so the loaded counts match the CSV exactly: 16,892
electors across 7,140 households, of which 70 are legal descriptions without coordinates and 11 are
flagged institutions.

Note: `household.n_nonresident` is the pipeline's count and includes the 4 electors whose
`resident_class` is `unknown`, summing to 394; `/api/stats/overview` counts `nonresidents` strictly
as `resident_class = 'non-resident'`, which is 390.
</details>

## Status

Honest version, as of v1.1.0:

| Phase | State |
|---|---|
| **1 — Foundation and read-only viewer** | **Shipped.** Compose stack, schema, importer, sign-in with roles and invite links, municipality-wide map with filters and search, household card, stats, audit log, encrypted backups, purge. |
| **2 — Canvassing core** | **Shipped.** Turfs from streets or a drawn polygon, assignments, the phone door screen, volunteers scoped to their turfs, latest-status colouring, follow-up queue, volunteer activity. |
| **Lawn signs** (not in the original plan) | **Shipped.** GPS placement with accuracy and photo, boundary check, pickup list, delivery list from `contact.wants_sign`. |
| **3 — Field hardening** | **Shipped.** Offline write queue and turf cache, sign photos held until they can upload, nearest-first ordering, the printable paper turf sheet, add-to-home-screen, and a proper tablet layout. |
| **Drive mode** (not in the original plan) | **Shipped in 1.1.0, not yet road-tested.** The next door ahead of a vehicle rather than the nearest, side of the road, hands-free speech, screen kept awake. The selection maths is unit-tested; the test that counts is a real concession road, and that has not happened yet. |
| **4 — Reporting and admin** | **Partly shipped.** The diff-based re-import is done (`make import-diff`, then `make import-apply`): a newer list is applied in place and every contact, sign, consent record, turf and sign-up is kept. **Still planned:** coverage and support reports by ward / community / turf / day, and CSV export with an audit entry per download. |
| **5 — Opt-in messaging** | **Shipped, sending switched off by default.** SMS with email fallback to electors who said yes, consent per purpose, STOP honoured before the next send, CRTC hours enforced in code, a test-send and a typed-word approval before anything goes out, a drip across the day. `MESSAGING_PROVIDER=log` until a provider is configured. |
| **6 — Advertising**, **7 — Notifications** | **Planned.** Designs in [`docs/phase-6-advertising-plan.md`](docs/phase-6-advertising-plan.md) and [`docs/phase-7-notifications-plan.md`](docs/phase-7-notifications-plan.md). |
| **8 — Website subscriber link** | **Shipped.** Five-minute pull sync from the campaign website, local exact + fuzzy voter matching, the organiser Sign-ups queue with one-click confirmation, and a decision ledger that survives re-imports. |

Full history is in [`CHANGELOG.md`](CHANGELOG.md), and the same changelog, roadmap and a
"how it works" guide are readable inside the app from the account page.

## Documents

| File | Authority for |
|---|---|
| [`API.md`](API.md) | The endpoint and role contract — request/response shapes, audit actions, env vars. **Authoritative.** |
| [`docs/README.md`](docs/README.md) | Architecture, tech stack, data model, request lifecycle |
| [`CLAUDE.md`](CLAUDE.md) | Working conventions for changing this codebase |
| [`prompt_plan.md`](prompt_plan.md) | The four phases and what is deliberately deferred |
| [`CHANGELOG.md`](CHANGELOG.md) | Version history |
| [`docs/TODO.md`](docs/TODO.md) | What is blocking, what was asked for and not started, and what is deliberately not being built |
| [`docs/superpowers/`](docs/superpowers/) | Design specs and implementation plans for individual features (drive mode so far) |

## Licence

No licence file. This is campaign infrastructure built for one election, published so the approach
can be read rather than reused as-is; all rights reserved unless that changes.

**Nothing in this repository contains voters-list data.** `data/*.csv`, `data/sign-photos/`,
`web/screenshots/`, `backups/` and `.env*` are all git-ignored, and they should stay that way.
