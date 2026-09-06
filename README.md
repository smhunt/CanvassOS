# Middlesex Centre Canvass

Self-hosted voter map and canvassing tool for the Sean Hunt mayoral campaign (Middlesex Centre, Ontario;
election day **October 26, 2026**). Phase 1 = data import, login with roles, read-only map/search/stats.

Stack: PostgreSQL 16 (PostGIS image, plain-SQL schema in Phase 1) · Fastify + TypeScript API · React SPA ·
Caddy (TLS + static + reverse proxy) · a one-shot Python importer. Everything runs in `docker compose`.

```
canvass/
  docker-compose.yml   db, api, web (build-only), caddy, importer (profile "import")
  Caddyfile            TLS for $DOMAIN, /api/* -> api:3000, SPA fallback, security headers
  .env.example         copy to .env
  Makefile             up, down, logs, import, backup, restore, purge, psql, test
  db/schema.sql        applied automatically on the first boot of the db container
  importer/            import.py — loads data/voters_final.csv + data/households.csv
  api/                 Fastify API (see API.md for the contract)
  web/                 React SPA (built by the web agent; see "web/Dockerfile contract")
  data/                voters_final.csv, households.csv (git-ignored), mc_boundary.json (tracked)
  backups/             encrypted dumps from `make backup` (git-ignored)
```

## Municipal Elections Act — handling the voters list

The voters list is personal information supplied under the Ontario *Municipal Elections Act, 1996*
(s. 23 and s. 88). Everyone with an account must understand:

- **Election purposes only.** The list may be used only for the purposes of this election campaign.
  No other use, no sharing outside the campaign, no merging into other contact lists.
- **Access is logged.** Every login, household card view, search, invite and export is written to
  `audit_log` (admin: `GET /api/audit`). Volunteers never receive mailing addresses, resident status or
  municipality-wide search; in Phase 1 they see only anonymous household points on the map.
- **Keep it secure.** TLS only, login required for every page, strong passwords (min 10 chars), encrypted
  backups, no copies of the CSVs on laptops or phones once imported.
- **Destroy after the election.** After October 26, 2026 (and after any recount/compliance period the
  clerk indicates): `make purge` on the server, delete `backups/*.gpg` and any off-site copies, and
  delete the pipeline outputs (`voters_final.csv`, `households.csv`, `.xlsx`). Keep a note of the date
  it was done.

## Deploying on an Ubuntu Docker host

Prerequisites: Ubuntu 22.04/24.04, Docker Engine + compose v2 (`docker compose version`), `make`, `gpg`.
A public DNS **A record** `canvass.sean-hunt.com → <server IP>` and inbound **ports 80 and 443** open
(Caddy obtains and renews the Let's Encrypt certificate itself; port 80 is needed for the challenge and
the HTTP→HTTPS redirect).

```bash
git clone <repo> canvass && cd canvass
cp .env.example .env
$EDITOR .env          # DOMAIN, POSTGRES_PASSWORD, SESSION_SECRET (openssl rand -base64 48),
                      # ADMIN_EMAIL, ADMIN_PASSWORD (>= 10 chars), BACKUP_PASSPHRASE
make up               # builds api + web, starts db → api → web(build) → caddy
make logs SERVICE=caddy   # wait for "certificate obtained"
```

Copy the two pipeline outputs to `data/` (scp; they are git-ignored) and load them:

```bash
scp voters_final.csv households.csv server:canvass/data/
make import LABEL="voters list export 2026-09-03"
```

The importer prints the `hh_flag` values it saw, per-ward / per-community counts, legal and institution
counts, and refuses to run twice on identical files (sha256 recorded in `import_run`). See "Re-importing".

## Deploying behind a Cloudflare Tunnel (current setup)

The campaign runs the stack on the office Mac and publishes it through a Cloudflare Tunnel, so no
router port-forward is needed and the home IP is never exposed. TLS terminates at the Cloudflare
edge; Caddy therefore serves plain HTTP on `127.0.0.1:3031` and nothing binds a public port.

```bash
make up-tunnel      # same stack as `make up`, but Caddy -> 127.0.0.1:3031, no 80/443, no Let's Encrypt
make tunnel-status  # is the origin answering?
```

`docker-compose.tunnel.yml` overlays the base compose file and swaps in `Caddyfile.tunnel`.

**Client IPs.** `Caddyfile.tunnel` rewrites `X-Forwarded-For` from `CF-Connecting-IP` before proxying
to the API. Without it every `audit_log` row would record the tunnel's own address, which would
defeat the point of the log under the Municipal Elections Act.

### DNS: delegate only the subdomain

`sean-hunt.com` is on OpenSRS nameservers (`ns1/2/3.systemdns.com`) and carries the campaign's
**Google Workspace MX records**. Do **not** move the whole zone to Cloudflare just for this app — a
mistake there takes down campaign email. Instead delegate the single subdomain:

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
4. To keep it up across reboots: `sudo cloudflared --config ~/.cloudflared/canvass.yml service install`.

**Fallbacks if a subdomain zone is not available:** point `canvass.sean-hunt.com` at the home IP with
an A record at OpenSRS and forward ports 80/443 on the router (then use plain `make up`, and Caddy
gets a Let's Encrypt cert itself) — or move the stack to a small VPS, which is what
"Deploying on an Ubuntu Docker host" below describes.

**Operational caveats of hosting on the Mac:** the app is unreachable whenever the machine sleeps or
leaves the network, and the voters list lives on that disk — so keep FileVault on, keep `make backup`
running, and remember `make purge` after October 26, 2026.

### First login

Browse to `https://canvass.sean-hunt.com`, sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. The admin
account is created **only on first boot when no users exist**; after that the two variables are ignored
and can be removed from `.env`. **Change the password immediately** (account menu → change password;
`POST /api/auth/change-password`). Changing it also logs out every other session.

### Inviting users

Admin → Users → Invite: email, name, role (`admin`, `organizer`, `volunteer`). The API returns an
`invite_url` (`https://$DOMAIN/invite/<token>`, valid 7 days, single use). There is no email service in
Phase 1: send the link yourself (Signal/text/email). The invitee sets their name and password. "Re-invite"
issues a fresh link and doubles as a password reset. Deactivating a user ends their sessions; the last
active admin cannot be deactivated or demoted.

Roles: **volunteer** — map with household points only (Phase 2 scopes the door screen to assigned turfs).
**organizer** — everything: household cards with voter names and mailing details, search, streets, stats,
legal (unmapped) households. **admin** — organizer + users, invites, audit log.

### Day-to-day

```bash
make ps / make logs [SERVICE=api]   # status, logs
make restart                        # after editing .env (rebuilds api/web images)
make psql                           # psql inside the db container
make down                           # stop; data stays in the pgdata volume
```

### Backups

`make backup` runs `pg_dump | gzip | gpg --symmetric --cipher-algo AES256` with `BACKUP_PASSPHRASE` from
`.env` and writes `backups/canvass-<timestamp>.sql.gz.gpg`. Copy that file off the server (it is useless
without the passphrase; keep the passphrase somewhere other than the server). Restore onto a fresh stack:
`make up`, then `make restore FILE=backups/canvass-<timestamp>.sql.gz.gpg` (the dump carries
`--clean --if-exists`, so it replaces the empty schema created on first boot). A daily cron line:
`0 3 * * * cd /srv/canvass && make backup && find backups -name '*.gpg' -mtime +14 -delete`.

### Re-importing a newer list

The importer is idempotent on identical files. Different files replace `household`/`voter` inside one
transaction. **Phase 1 limitation:** if canvass `contact` rows exist, the importer refuses (exit 2)
because replacing the list would orphan them; `make import-force` replaces the list *and deletes all
contacts*. Phase 4 adds a diff-based re-import (new / removed / moved voters, matched on
`voter.natural_key`) that preserves contacts.

### Purge (after the election)

```bash
make backup                 # optional final encrypted archive, if the campaign must retain one briefly
make purge                  # type PURGE: stops the stack, deletes the db/web/caddy volumes, shreds data/*.csv
rm -f backups/*.gpg         # and any off-site copies
```

## Development

Test database (plain Postgres 16 is fine in Phase 1): `postgresql://canvass:canvass@localhost:5443/canvass`
with `db/schema.sql` applied (`psql -f db/schema.sql`; reset with `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`).

```bash
pip install 'psycopg[binary]'
python3 importer/import.py --voters data/voters_final.csv --households data/households.csv \
    --label "voters list export 2026-09-03" --database-url postgresql://canvass:canvass@localhost:5443/canvass

cd api && npm install
DATABASE_URL=postgresql://canvass:canvass@localhost:5443/canvass SESSION_SECRET=$(openssl rand -hex 32) \
  DOMAIN=localhost ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=dev-password-1 COOKIE_SECURE=false PORT=3130 \
  npm run dev                # tsx watch; http://localhost:3130/api/health
npm test                     # integration tests against TEST_DATABASE_URL (default: the URL above)
```

`npm test` truncates `app_user`/`session`/`audit_log` on the test database (it creates its own admin,
organizer and volunteer) and computes expected counts from `../data/*.csv`.

```bash
cd web && npm install
npm run dev                  # https://dev.ecoworks.ca:3030 — /api is proxied to the API on 3130
npm run build && npm run preview   # https://dev.ecoworks.ca:4173 (what tools/e2e.py drives)
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

The Vite dev and preview servers serve HTTPS using the shared mkcert cert at
`~/Code/.traefik/certs/{cert,key}.pem` (falling back to plain HTTP if it is missing). Because dev is
TLS, the session cookie keeps its `Secure` flag end to end — `COOKIE_SECURE=false` is only needed if
you hit the API directly over plain http rather than through the Vite proxy.

API env: `DATABASE_URL`, `SESSION_SECRET` (≥ 32 chars), `DOMAIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`PORT` (3000), `TRUST_PROXY` (1), `COOKIE_SECURE` (true; set `false` for plain-http dev),
`BOUNDARY_PATH` (`../data/mc_boundary.json`; compose mounts it at `/data/mc_boundary.json`), `LOG_LEVEL`.

### web/Dockerfile contract

`docker-compose.yml` treats `web` as a **build-only** stage: it runs
`sh -c "rm -rf /srv/* && cp -r /app/dist/. /srv/"` with the named volume `webroot` mounted at `/srv`, then
exits; Caddy starts after it completes and serves `/srv` with `try_files {path} /index.html`.
Therefore **`web/Dockerfile` must produce the production build at `/app/dist`** (Vite default when
`WORKDIR /app`) and its final image must contain `sh`, `rm` and `cp` (any `node:*-alpine` or
`alpine` base does; do not use a `scratch`/nginx image). The SPA calls the API at the same origin under
`/api/*` and must route `/invite/<token>` to the accept-invite screen. No nginx: Caddy serves the files.

## Importer field mapping

`households.csv` → `household`: `address = address_clean`, `property_address_raw = property_address`,
`civic_num/street/street_type/street_dir/unit = num/street/type/dir/unit`, `is_legal = household_id`
starts with `H-LEGAL` or `addr_match == 'legal'`, `is_institution = 'institution' in hh_flag`
(the only non-empty `hh_flag` values are `legal description, no civic address` and
`large (8+ voters at one address, likely multi-unit / institution without unit numbers)`),
`n_po_box = n_mail_po_box`, `street_sort = street type dir` (space-joined, trimmed),
`num_sort` = leading integer of `num` (`122 1/2` → 122; NULL for legal rows).

`voters_final.csv` → `voter`: `last_name = last_name_clean`, `name_raw = last_name || ', ' || first_names`
(raw list columns), `natural_key = lower(last_name) || ', ' || lower(first_names) || '|' || property_address`.
The list contains two people listed twice at the same property (`LORENC, JAYNE F` at 119 KING ST and
`EMPSON, TANYA L` at 22893 HIGHBURY AVE N); because `natural_key` is UNIQUE, the second occurrence gets a
`#2` suffix and both rows are kept, so counts match the CSV (16,892 voters / 7,139 households, of which
70 are legal descriptions without coordinates and 11 are flagged institutions).

Note: `household.n_nonresident` is the pipeline's count, which includes the 4 voters whose
`resident_class` is `unknown` (341 in total); `/api/stats/overview` counts `nonresidents` strictly as
`resident_class = 'non-resident'` (337).
