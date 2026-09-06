# Middlesex Centre Canvass

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

## Why it looks the way it does

The interesting parts of this codebase are not the features. They are the four constraints the
features had to be built around.

### 1. The list is not ours to keep

The voters list is personal information supplied under Ontario's *Municipal Elections Act, 1996*
(s. 23, s. 88). It may be used for election purposes only, and it must be destroyed afterwards.
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
It is not audited twice either. That seam is what the Phase 3 offline queue will drain into.

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
git clone https://github.com/smhunt/mc-canvass && cd mc-canvass
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

Two shapes. Both start from `cp .env.example .env`, which wants `DOMAIN`, `POSTGRES_PASSWORD`,
`SESSION_SECRET` (`openssl rand -base64 48`), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (≥ 10 chars) and
`BACKUP_PASSPHRASE`.

<details>
<summary><b>A. Public Docker host (Ubuntu VM or VPS) — Caddy gets its own certificate</b></summary>

Prerequisites: Ubuntu 22.04/24.04, Docker Engine + compose v2 (`docker compose version`), `make`,
`gpg`. A public DNS **A record** `canvass.sean-hunt.com → <server IP>` and inbound **ports 80 and
443** open — Caddy obtains and renews the Let's Encrypt certificate itself, and port 80 is needed
for the ACME challenge and the HTTP→HTTPS redirect.

```bash
git clone <repo> canvass && cd canvass
cp .env.example .env && $EDITOR .env
make up                       # builds api + web, starts db → api → web(build) → caddy
make logs SERVICE=caddy       # wait for "certificate obtained"
```
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

**DNS: delegate only the subdomain.** `sean-hunt.com` is on OpenSRS nameservers
(`ns1/2/3.systemdns.com`) and carries the campaign's **Google Workspace MX records**. Do **not**
move the whole zone to Cloudflare just for this app — a mistake there takes down campaign email.
Instead delegate the single subdomain:

1. Cloudflare dashboard → **Add a site** → enter `canvass.sean-hunt.com` (a subdomain zone, not the
   apex). Cloudflare assigns two nameservers. If your plan will not accept a subdomain zone, see the
   fallbacks below.
2. At OpenSRS, add **NS** records on the parent zone delegating `canvass` to those two nameservers.
   The apex, `www` and MX are untouched.
3. Authorise this machine and create the tunnel:
   ```bash
   cloudflared tunnel login                      # browser OAuth, writes ~/.cloudflared/cert.pem
   cloudflared tunnel create canvass             # prints the tunnel UUID + writes <UUID>.json
   cp deploy/cloudflared-canvass.yml ~/.cloudflared/canvass.yml
   $EDITOR ~/.cloudflared/canvass.yml            # paste the UUID in both places
   cloudflared tunnel route dns canvass canvass.sean-hunt.com
   cloudflared tunnel --config ~/.cloudflared/canvass.yml run
   ```
4. To keep it up across reboots:
   `sudo cloudflared --config ~/.cloudflared/canvass.yml service install`.

**Fallbacks if a subdomain zone is not available:** point `canvass.sean-hunt.com` at the home IP
with an A record at OpenSRS and forward ports 80/443 on the router (then use plain `make up`, and
Caddy gets a Let's Encrypt cert itself) — or move the stack to a small VPS, which is shape A.

**Operational caveats of hosting on the Mac:** the app is unreachable whenever the machine sleeps or
leaves the network, and the voters list lives on that disk — so keep FileVault on, keep `make backup`
running, and remember `make purge` after 26 October 2026.
</details>

### Loading the list

Copy the two pipeline outputs to `data/` (they are git-ignored) and load them:

```bash
scp voters_final.csv households.csv server:canvass/data/
make import LABEL="voters list export 2026-09-03"
```

The importer prints the `hh_flag` values it saw, per-ward and per-community counts, legal and
institution counts, and verifies every total after loading — a mismatch rolls the whole transaction
back. It refuses to run twice on identical files (sha256 recorded in `import_run`).

### First login and inviting people

Browse to `https://canvass.sean-hunt.com` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. The
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

## Municipal Elections Act — handling the voters list

The voters list is personal information supplied under the Ontario *Municipal Elections Act, 1996*
(s. 23 and s. 88). Everyone with an account must understand:

- **Election purposes only.** The list may be used only for the purposes of this election campaign.
  No other use, no sharing outside the campaign, no merging into other contact lists. Phone numbers
  and emails collected at the door are governed by the consent given for them and must never be
  merged back into an export of the list.
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
from `.env` and writes `backups/canvass-<timestamp>.sql.gz.gpg`. Copy that file off the server — it
is useless without the passphrase, so keep the passphrase somewhere other than the server.

Restore onto a fresh stack: `make up`, then
`make restore FILE=backups/canvass-<timestamp>.sql.gz.gpg` (the dump carries `--clean --if-exists`,
so it replaces the empty schema created on first boot).

A daily cron line:

```
0 3 * * * cd /srv/canvass && make backup && find backups -name '*.gpg' -mtime +14 -delete
```
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
make purge                  # type PURGE: stops the stack, deletes the db/web/caddy/photo volumes,
                            # shreds data/*.csv and data/sign-photos
rm -f backups/*.gpg         # and any off-site copies
```
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
`PORT` (3000), `TRUST_PROXY` (1), `COOKIE_SECURE` (true; `false` for plain-HTTP dev),
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

Honest version, as of v0.3.0:

| Phase | State |
|---|---|
| **1 — Foundation and read-only viewer** | **Shipped.** Compose stack, schema, importer, sign-in with roles and invite links, municipality-wide map with filters and search, household card, stats, audit log, encrypted backups, purge. |
| **2 — Canvassing core** | **Shipped.** Turfs from streets or a drawn polygon, assignments, the phone door screen, volunteers scoped to their turfs, latest-status colouring, follow-up queue, volunteer activity. |
| **Lawn signs** (not in the original plan) | **Shipped.** GPS placement with accuracy and photo, boundary check, pickup list, delivery list from `contact.wants_sign`. |
| **3 — Field hardening** | **In progress.** Walking order along the street and the printable paper turf sheet have landed. The offline turf cache and its sync queue are being built onto the idempotency key every write already carries. |
| **4 — Reporting and admin** | **Planned.** Coverage and support reports by ward / community / turf / day, CSV export with an audit entry per download, diff-based re-import that preserves contacts. |

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

## Licence

No licence file. This is campaign infrastructure built for one election, published so the approach
can be read rather than reused as-is; all rights reserved unless that changes.

**Nothing in this repository contains voters-list data.** `data/*.csv`, `data/sign-photos/`,
`web/screenshots/`, `backups/` and `.env*` are all git-ignored, and they should stay that way.
