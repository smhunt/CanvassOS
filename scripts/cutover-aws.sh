#!/usr/bin/env bash
# Move CanvassOS production from the office Mac to the AWS box — or back again.
#
#   ./scripts/cutover-aws.sh preflight              read-only checks on both machines; safe at any time
#   ./scripts/cutover-aws.sh prepare                no production impact: refresh EC2's code, rebuild it, empty its database
#   ./scripts/cutover-aws.sh sync                   no production impact: copy the Mac's data to EC2 (the Mac stays production)
#   ./scripts/cutover-aws.sh cutover                THE WINDOW (~15 min): freeze, dump, restore, verify, switch the tunnel
#   ./scripts/cutover-aws.sh finish                 once you have checked it on a phone: make the Mac unable to resume by accident
#   ./scripts/cutover-aws.sh rollback [--with-data] put production back on the Mac
#
# Run it on the office Mac, from the repo root. It drives the EC2 box over `ssh canvass-prod`
# (SSH over SSM — the instance has no inbound rule at all).
#
# The four things this script exists to get right, because each one loses data quietly:
#
#  1. SPLIT BRAIN. Two cloudflared connectors on one tunnel do not fail over — Cloudflare load-balances
#     across them. With the Mac and EC2 both connected, half the volunteers write doors into one
#     Postgres and half into the other, and nothing can merge them afterwards. So EC2's connector is
#     started only after `cloudflared tunnel info` shows ZERO connectors, never on a timer or a guess.
#
#  2. THE FREEZE MUST STOP EVERY WRITER, not just the tunnel. The Mac's API container runs the
#     subscriber sync every five minutes and writes audit_log and public_request rows with no request
#     at all, and the dev API on :3130 is connected to the same real database. Leave either running
#     and the dump and the baseline drift apart — which is exactly the mismatch the gate aborts on.
#
#  3. A 4xx DURING THE WINDOW IS WORSE THAN AN OUTAGE. web/src/offline/outbox.ts retries a network
#     failure or a 5xx for about seventy minutes, but PARKS an entry permanently on any other 4xx. A
#     phone replaying a door against a half-restored database gets a 404 and that door is lost until
#     someone taps "Try again". So EC2 is never reachable on the real hostname until its row counts
#     match the Mac's exactly.
#
#  4. THE GATE IS A DIFF, NOT A GLANCE. Exact per-table counts from both databases are written to
#     files and compared; any difference aborts before the tunnel moves.
#
# Everything is appended to backups/cutover-<stamp>.log (git-ignored). The log holds counts, hashes
# and hostnames — never a row of the voters list.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Confirmations read the script's ORIGINAL stdin on fd 3; every child process gets /dev/null.
# `docker compose exec` attaches stdin even with -T, and ssh does unless told -n, and either one
# swallows the typed or piped answer to the next prompt — two runs ended as "not confirmed" that way.
exec 3<&0 0</dev/null

TUNNEL=406862e6-5c64-434b-a377-3a5b544a883a          # the production tunnel (named "middle-manager")
STAGING_TUNNEL=canvass-aws
STAGING_HOST=canvass-aws.webarchitecture.ca
PUBLIC_HOST=canvass.webarchitecture.ca
AGENT=ca.webarchitecture.canvass-tunnel               # the Mac's LaunchAgent for cloudflared
PLIST="$HOME/Library/LaunchAgents/$AGENT.plist"
CREDS="$HOME/.cloudflared/$TUNNEL.json"
EC2=canvass-prod                                      # ssh alias, see ~/.ssh/config
EC2_DIR=/srv/canvass
DB=canvass-db-1; API=canvass-api-1; CADDY=canvass-caddy-1   # same names on both hosts (compose project "canvass")
DEV_API_PORT=3130
# Keys that must be byte-identical on both hosts. SESSION_SECRET keeps every volunteer logged in,
# DOMAIN keeps already-sent invite links alive, BACKUP_PASSPHRASE is what EC2 decrypts the dump with.
MUST_MATCH="SESSION_SECRET DOMAIN BACKUP_PASSPHRASE"
# The only key EC2 is expected to have that the Mac does not.
EC2_ONLY_OK="BACKUP_S3_URI"

STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
LOG="backups/cutover-$STAMP.log"
exec > >(tee -a "$LOG") 2>&1

FAILS=0; WARNS=0
say()  { printf '\n=== %s ===\n' "$*"; }
ok()   { printf '  PASS  %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; WARNS=$((WARNS+1)); }
bad()  { printf '  FAIL  %s\n' "$*"; FAILS=$((FAILS+1)); }
die()  { printf '\nABORT: %s\n' "$*" >&2; exit 1; }

# -n: never read this script's stdin. Without it ssh swallows the typed (or piped) answer to the
# next confirmation prompt, and the script aborts as "not confirmed".
remote() { ssh -n -o BatchMode=yes -o ConnectTimeout=40 "$EC2" "cd $EC2_DIR && $1"; }

confirm() { # confirm WORD "what is about to happen"
  printf '\n%s\n' "$2"
  local ans; printf 'Type %s to continue: ' "$1"; read -r -u 3 ans || ans=""; printf '\n'
  [ "$ans" = "$1" ] || die "not confirmed"
}

# One line per live connector on the production tunnel: "<arch> <origin-ip>".
connectors() {
  cloudflared tunnel info "$TUNNEL" 2>/dev/null \
    | awk '/^[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+[ \t]/ {print $3, $5}'
}
connector_count() { connectors | grep -c . || true; }

# curl already prints 000 when it cannot connect; `|| true` only stops set -e from ending the script.
public_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$PUBLIC_HOST/api/health?$1" || true; }
connectors_is() { [ "$(connector_count)" = "$1" ]; }      # re-evaluated on every try, unlike "$(...)" in an argument
public_is()     { [ "$(public_code "$2")" = "$1" ]; }

wait_until() { # wait_until "description" tries sleep_s command...
  local what=$1 tries=$2 nap=$3; shift 3
  local i=0
  while [ "$i" -lt "$tries" ]; do
    if "$@" >/dev/null 2>&1; then ok "$what"; return 0; fi
    i=$((i+1)); sleep "$nap"
  done
  return 1
}

# Exact counts, not pg_stat estimates: this file is the evidence that nothing was lost.
COUNTS_SQL="SELECT table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name; SELECT 'import_run.max_id|' || coalesce(max(id)::text,'none') FROM import_run; SELECT 'audit_log.latest|' || coalesce(max(at)::text,'none') FROM audit_log; SELECT 'contact.latest|' || coalesce(max(at)::text,'none') FROM contact;"
counts_local()  { printf '%s\n' "$COUNTS_SQL" | docker exec -i "$DB" psql -U canvass -d canvass -At -v ON_ERROR_STOP=1; }
counts_remote() { printf '%s\n' "$COUNTS_SQL" | ssh -o BatchMode=yes "$EC2" "docker exec -i $DB psql -U canvass -d canvass -At -v ON_ERROR_STOP=1"; }

env_fp_local() { grep -E '^[A-Za-z0-9_]+=' .env | while IFS='=' read -r k v; do printf '%s %s\n' "$k" "$(printf %s "$v" | shasum -a 256 | cut -c1-12)"; done | sort; }
env_fp_remote() { ssh -o BatchMode=yes "$EC2" 'bash -s' <<'REMOTE'
cd /srv/canvass && grep -E '^[A-Za-z0-9_]+=' .env | while IFS='=' read -r k v; do printf '%s %s\n' "$k" "$(printf %s "$v" | sha256sum | cut -c1-12)"; done | sort
REMOTE
}

photos_local()  { docker run --rm -v canvass_signphotos:/p:ro alpine sh -c 'find /p -type f | wc -l' | tr -d '[:space:]'; }
photos_remote() { ssh -n -o BatchMode=yes "$EC2" "docker run --rm -v canvass_signphotos:/p:ro alpine sh -c 'find /p -type f | wc -l'" | tr -d '[:space:]'; }

# ------------------------------------------------------------------------------------------------
# preflight: read-only. `strict` is what cutover demands; without it, things prepare will fix are
# warnings rather than failures.
# ------------------------------------------------------------------------------------------------
preflight() {
  local strict=${1:-}
  say "tools on this Mac"
  local t; for t in docker cloudflared ssh scp gpg shasum curl git; do command -v "$t" >/dev/null 2>&1 && ok "$t" || bad "$t is not installed"; done
  [ -f "$HOME/.cloudflared/cert.pem" ] && ok "cloudflared account cert (needed to read connector state)" || bad "~/.cloudflared/cert.pem missing"

  say "this repo"
  local head; head=$(git rev-parse --short HEAD); ok "HEAD $head on $(git branch --show-current)"
  [ -z "$(git status --porcelain --untracked-files=no)" ] && ok "no uncommitted changes to tracked files" || bad "tracked files have uncommitted changes — EC2 would not get them"

  say "the Mac (production today)"
  docker inspect -f '{{.State.Running}}' "$DB" 2>/dev/null | grep -q true && ok "database container running" || bad "$DB is not running"
  [ -n "$(sed -n 's/^BACKUP_PASSPHRASE=//p' .env | tail -1)" ] && ok "BACKUP_PASSPHRASE is set" || bad "BACKUP_PASSPHRASE is empty — make backup would refuse"
  local pend; pend=$(./db/migrate.sh status 2>/dev/null | awk '/^pending/{f=1;next} f&&/\.sql/{n++} END{print n+0}')
  [ "$pend" = 0 ] && ok "no pending migrations" || bad "$pend pending migration(s) on the Mac — apply and re-test before moving"
  local n; n=$(photos_local); [ "$n" = 0 ] && ok "no sign photos (pg_dump would not carry them)" || bad "$n sign photo(s) on the Mac — this script does not move the signphotos volume yet; do not cut over"
  if lsof -nP -iTCP:$DEV_API_PORT -sTCP:LISTEN >/dev/null 2>&1; then warn "a dev API is listening on :$DEV_API_PORT against the REAL database — cutover will stop it"; else ok "no dev API on :$DEV_API_PORT"; fi

  say "the tunnel"
  local c; c=$(connectors); local cn; cn=$(printf '%s\n' "$c" | grep -c . || true)
  printf '%s\n' "$c" | sed 's/^/        connector: /'
  if [ "$cn" = 1 ] && printf '%s' "$c" | grep -q '^darwin'; then ok "exactly one connector, and it is this Mac"; else bad "expected exactly one darwin connector, found $cn"; fi
  local code; code=$(public_code preflight); [ "$code" = 200 ] && ok "https://$PUBLIC_HOST answers 200" || bad "https://$PUBLIC_HOST answers $code"

  say "the EC2 box"
  if ! remote 'true' 2>/dev/null; then bad "cannot reach $EC2 over ssh (AWS credentials? session-manager-plugin?)"; say "result"; printf '  %s failure(s), %s warning(s)\n' "$FAILS" "$WARNS"; return 1; fi
  ok "ssh $EC2 works"
  local rhead; rhead=$(remote 'git rev-parse --short HEAD')
  if [ "$rhead" = "$head" ]; then ok "code matches this repo ($rhead)"; elif [ -n "$strict" ]; then bad "EC2 is at $rhead, this repo at $head — run prepare"; else warn "EC2 is at $rhead, this repo at $head — prepare will refresh it"; fi
  remote 'curl -fsS --max-time 8 http://127.0.0.1:3031/api/health' >/dev/null 2>&1 && ok "stack healthy on its loopback origin" || bad "EC2 stack is not answering on 127.0.0.1:3031"
  [ "$(remote 'systemctl is-active cloudflared 2>/dev/null || true')" = active ] && bad "EC2's PRODUCTION cloudflared is already active — that is split brain if the Mac is too" || ok "EC2's production connector is not running"
  if [ "$(remote "systemctl is-active cloudflared-staging 2>/dev/null || true")" = active ]; then
    if [ -n "$strict" ]; then bad "the staging tunnel is still up — after cutover it would publish production on a second hostname; run prepare"; else warn "the staging tunnel is up — prepare will stop it"; fi
  else ok "staging tunnel is not running"; fi
  remote "sudo test -f /etc/cloudflared/$TUNNEL.json && sudo grep -q '$PUBLIC_HOST' /etc/cloudflared/config.yml" && ok "production tunnel credentials and config are on the box" || bad "production tunnel credentials/config missing in /etc/cloudflared"
  n=$(photos_remote); [ "$n" = 0 ] && ok "no sign photos on EC2" || warn "$n sign photo(s) already on EC2"
  local used; used=$(remote "df -P / | awk 'NR==2{gsub(\"%\",\"\",\$5); print \$5}'"); used=${used:-100}; [ "$used" -lt 80 ] && ok "disk ${used}% used" || bad "EC2 disk ${used}% used"
  local rnow; rnow=$(remote 'date -u +%s'); local skew=$(( $(date -u +%s) - ${rnow:-0} )); skew=${skew#-}
  [ "$skew" -lt 60 ] && ok "clocks agree to ${skew}s" || bad "clock skew ${skew}s — audit timestamps would jump"

  say ".env parity (fingerprints only — no value is ever printed)"
  local a b; a=$(mktemp); b=$(mktemp); env_fp_local > "$a"; env_fp_remote > "$b"
  local k
  for k in $MUST_MATCH; do
    if [ -n "$(grep "^$k " "$a")" ] && [ "$(grep "^$k " "$a")" = "$(grep "^$k " "$b")" ]; then ok "$k identical"; else bad "$k differs or is missing — this one is a blocker"; fi
  done
  # diff exits 1 when the files differ — which is the normal case here — and under pipefail that
  # would end the script in the middle of a report.
  local others; others=$( { diff "$a" "$b" || true; } | awk '/^[<>]/{print $2}' | sort -u | tr '\n' ' ')
  for k in $others; do
    case " $MUST_MATCH " in *" $k "*) continue;; esac
    if [ "$k" = "$EC2_ONLY_OK" ] && ! grep -q "^$k " "$a"; then ok "$k exists only on EC2 (expected)"; else warn "$k differs between the two .env files — check it is intentional"; fi
  done
  [ -z "$others" ] && ok "no other differences"
  rm -f "$a" "$b"

  say "result"
  printf '  %s failure(s), %s warning(s)      log: %s\n' "$FAILS" "$WARNS" "$LOG"
  [ "$FAILS" = 0 ]
}

# ------------------------------------------------------------------------------------------------
# prepare: everything slow, done outside the window. Touches only EC2.
# ------------------------------------------------------------------------------------------------
prepare() {
  say "prepare — production on the Mac is not touched"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "commit or stash tracked changes first; EC2 gets exactly what is committed"
  remote 'true' || die "cannot reach $EC2"
  [ "$(remote 'systemctl is-active cloudflared 2>/dev/null || true')" = active ] && die "EC2's production connector is active — this is not a box to wipe"
  confirm PREPARE "This refreshes EC2's code to $(git rev-parse --short HEAD), stops the staging tunnel ($STAGING_HOST goes dark),
DESTROYS the rehearsal database on EC2, and rebuilds the stack there. Nothing on the Mac changes."

  say "code"
  local tmp; tmp=$(mktemp -d); git bundle create "$tmp/canvass.bundle" main >/dev/null 2>&1
  scp -q "$tmp/canvass.bundle" "$EC2:/tmp/canvass.bundle"; rm -rf "$tmp"
  # GitHub does not have these commits (the push is a separate decision), so the box is fed a bundle.
  remote 'git fetch -q /tmp/canvass.bundle main && git reset -q --hard FETCH_HEAD && rm -f /tmp/canvass.bundle'
  [ "$(remote 'git rev-parse --short HEAD')" = "$(git rev-parse --short HEAD)" ] && ok "EC2 is at $(git rev-parse --short HEAD)" || die "EC2 did not reach this commit"

  say "staging tunnel"
  remote 'sudo systemctl disable --now cloudflared-staging >/dev/null 2>&1 || true'
  [ "$(remote 'systemctl is-active cloudflared-staging 2>/dev/null || true')" = active ] && die "staging tunnel would not stop" || ok "stopped and disabled — nothing on EC2 is reachable from outside now"

  say "empty database + rebuild (several minutes)"
  # Not `make purge`: that also shreds data/*.csv, which the first real re-import from the clerk needs.
  remote 'docker compose -f docker-compose.yml -f docker-compose.tunnel.yml down --volumes --remove-orphans >/dev/null 2>&1 && make up-tunnel >/dev/null 2>&1' || die "rebuild failed on EC2 — ssh in and run make up-tunnel to see why"
  wait_until "EC2 stack healthy" 60 5 remote 'curl -fsS --max-time 5 http://127.0.0.1:3031/api/health' || die "EC2 stack did not come up"
  remote 'curl -fsS http://127.0.0.1:3031/api/health' | grep -q '"import_id":null' && ok "database is empty (import_id null)" || die "EC2 database is not empty after the wipe"
  local pend want; pend=$(remote "./db/migrate.sh status 2>/dev/null | awk '/^pending/{f=1;next} f&&/\\.sql/{n++} END{print n+0}'"); want=$(ls db/migrations/*.sql | wc -l | tr -d ' ')
  # Deliberately NOT applied: the dump carries the migrated schema and the schema_migration rows.
  [ "$pend" = "$want" ] && ok "$pend migrations pending on the empty database — expected, and left alone on purpose" || warn "expected $want pending migrations on an empty database, saw $pend"
  say "prepared"
  printf '  EC2 is at %s, empty, healthy and unreachable from outside. Next: ./scripts/cutover-aws.sh cutover\n' "$(git rev-parse --short HEAD)"
}

# ------------------------------------------------------------------------------------------------
unfreeze_mac() { # put the Mac back exactly as it was before the freeze
  docker start "$API" "$CADDY" >/dev/null 2>&1 || true
  launchctl enable "gui/$(id -u)/$AGENT" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/$AGENT" 2>/dev/null || true
}

IN_WINDOW=0
# `die` exits rather than erroring, so an ERR trap would miss most mid-window failures. EXIT sees them all.
# The trailing sleep lets the tee logger drain before the shell exits; without it the last lines
# (an ABORT message, typically) can be lost from the terminal even though the log file has them.
trap 'rc=$?; if [ "$IN_WINDOW" = 1 ] && [ "$rc" -ne 0 ]; then mid_cutover_banner; fi; sleep 1' EXIT

mid_cutover_banner() {
  printf '\n!!! FAILED MID-CUTOVER. Production is FROZEN: nothing is serving %s. !!!\n' "$PUBLIC_HOST"
  printf '    Phones are queueing safely (they retry a dead host for about 70 minutes).\n'
  printf '    Nothing has been lost. To put production back on the Mac right now:\n\n'
  printf '        ./scripts/cutover-aws.sh rollback\n\n    log: %s\n' "$LOG"
}

cutover() {
  say "strict preflight"
  preflight strict || die "preflight has failures — fix them, or run prepare"

  local devpid; devpid=$(lsof -nP -t -iTCP:$DEV_API_PORT -sTCP:LISTEN 2>/dev/null | head -1 || true)
  confirm GO "THE WINDOW STARTS NOW. On GO this will:
  - stop the Mac's tunnel connector            -> https://$PUBLIC_HOST goes dark (phones queue; that is safe)
  - stop the Mac's API container               -> ends the 5-minute subscriber sync that writes with no request
  ${devpid:+- stop the dev API on :$DEV_API_PORT (pid $devpid)      -> it is connected to the real database
  }then dump, copy, restore on EC2, and compare every table before anything is switched."
  IN_WINDOW=1
  local t0; t0=$(date +%s)

  say "C1 freeze — stop every writer"
  launchctl bootout "gui/$(id -u)/$AGENT" 2>/dev/null || true
  pkill -f "cloudflared.*tunnel run" 2>/dev/null || true
  if ! wait_until "no connectors left on the production tunnel" 20 3 connectors_is 0; then
    unfreeze_mac; IN_WINDOW=0; die "the Mac's connector would not go away — unfroze, nothing changed"
  fi
  docker stop "$API" >/dev/null && ok "Mac API container stopped (subscriber sync ended)"
  [ -n "$devpid" ] && { kill "$devpid" 2>/dev/null || true; sleep 1; ok "dev API on :$DEV_API_PORT stopped"; }
  local code; code=$(public_code frozen)
  case "$code" in
    5*|000) ok "public hostname answers $code — a dead host, which phones retry" ;;
    200)    unfreeze_mac; IN_WINDOW=0; die "public hostname still answers 200 — something is still connected; unfroze" ;;
    *)      unfreeze_mac; IN_WINDOW=0; die "public hostname answers $code — a 4xx would PARK queued doors on phones; unfroze" ;;
  esac

  say "C2 final dump"
  [ "$(photos_local)" = 0 ] || die "a sign photo appeared — pg_dump does not carry it"
  make backup >/dev/null
  local dump; dump=$( { ls -t backups/canvass-*.sql.gz.gpg 2>/dev/null || true; } | head -1); [ -n "$dump" ] || die "make backup produced no file"; local sha; sha=$(shasum -a 256 "$dump" | cut -d' ' -f1)
  ok "$dump  sha256 ${sha:0:16}…"

  say "C3 baseline counts (the Mac, frozen)"
  counts_local > "backups/cutover-$STAMP.mac.counts"; ok "$(grep -c . "backups/cutover-$STAMP.mac.counts") lines -> backups/cutover-$STAMP.mac.counts"
  { grep -E '^(household|voter|contact|sign|voter_contact|audit_log)\|' "backups/cutover-$STAMP.mac.counts" || true; } | sed 's/^/        /'

  say "C4 copy to EC2"
  remote 'mkdir -p backups'; scp -q "$dump" "$EC2:$EC2_DIR/backups/"
  [ "$(remote "sha256sum backups/$(basename "$dump") | cut -d' ' -f1")" = "$sha" ] && ok "checksum matches on EC2" || die "checksum mismatch after copy"

  say "C5 restore on EC2"
  # EC2's API is stopped for the restore AND stays stopped through the gate. --clean drops tables, and
  # a sync mid-flight holds locks on them; and once it restarts, its subscriber sync writes audit_log
  # and can insert a public_request, which would make an exact comparison impossible.
  remote "docker stop $API >/dev/null && make restore FILE=backups/$(basename "$dump") >/dev/null 2>&1" || die "restore failed on EC2"
  ok "restored; EC2's API is still stopped"

  say "C6 THE GATE — every table, exact counts"
  counts_remote > "backups/cutover-$STAMP.ec2.counts"
  # Both databases are quiescent — every writer on the Mac is stopped, EC2's API has not started — so
  # this is an exact comparison of every table, audit_log and the latest timestamps included.
  if diff "backups/cutover-$STAMP.mac.counts" "backups/cutover-$STAMP.ec2.counts" >/dev/null; then
    ok "every table matches exactly ($(grep -c . "backups/cutover-$STAMP.ec2.counts") lines compared, no tolerance)"
  else
    { diff "backups/cutover-$STAMP.mac.counts" "backups/cutover-$STAMP.ec2.counts" || true; } | sed 's/^/        /'
    die "row counts differ — the tunnel has NOT moved. Run rollback, then find out why."
  fi
  remote "docker start $API >/dev/null"
  wait_until "EC2 API healthy on the restored data" 40 3 remote 'curl -fsS --max-time 5 http://127.0.0.1:3031/api/health' || die "EC2 API did not come back"

  say "C7 switch the tunnel"
  [ "$(connector_count)" = 0 ] || die "a connector reappeared on the production tunnel — refusing to start a second one"
  confirm GO "The data on EC2 is verified identical. On GO, EC2's connector starts and https://$PUBLIC_HOST is served from AWS."
  # Written by hand to mirror cloudflared-staging.service, which has run on this box for days;
  # `cloudflared service install` beside an existing sibling unit is a path nobody has tested.
  ssh -o BatchMode=yes "$EC2" 'sudo tee /etc/systemd/system/cloudflared.service >/dev/null' <<UNIT
[Unit]
Description=cloudflared (PRODUCTION tunnel -> $PUBLIC_HOST)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/cloudflared --config /etc/cloudflared/config.yml --no-autoupdate tunnel run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  remote 'sudo systemctl daemon-reload && sudo systemctl enable --now cloudflared >/dev/null 2>&1'
  wait_until "a connector has registered" 20 3 connectors_is 1 || true
  local i=0; local c; c=$(connectors); printf '%s\n' "$c" | sed 's/^/        connector: /'
  [ "$(printf '%s\n' "$c" | grep -c .)" = 1 ] && printf '%s' "$c" | grep -q '^linux' || die "expected exactly one linux connector — check NOW: cloudflared tunnel info $TUNNEL"
  ok "exactly one connector, and it is the EC2 box"

  say "C8 smoke test through the real hostname"
  local nonce="cutover-$STAMP"
  wait_until "https://$PUBLIC_HOST answers 200" 20 3 public_is 200 "$nonce" || die "public hostname is not answering 200 from EC2"
  # Proof of WHICH machine answered: the nonce has to show up in EC2's own access log.
  remote "docker logs --since 2m $CADDY 2>&1 | grep -q '$nonce'" && ok "that request is in EC2's access log — AWS is serving production" || warn "could not find the request in EC2's log — check by hand"
  IN_WINDOW=0

  say "done in $(( ($(date +%s) - t0) / 60 )) min $(( ($(date +%s) - t0) % 60 )) s"
  cat <<NEXT
  Production is on AWS. The Mac's stack is stopped but intact, its database frozen as of the dump.

  NOW, on a phone on cellular: sign in is still valid, open a turf, record one door, open drive mode.
  Then either:
      ./scripts/cutover-aws.sh finish      make it impossible for the Mac to resume by accident
      ./scripts/cutover-aws.sh rollback    put production back on the Mac

  evidence: backups/cutover-$STAMP.{log,mac.counts,ec2.counts}
NEXT
}

# ------------------------------------------------------------------------------------------------
# sync: copy the Mac's data to EC2 while the Mac stays production. No freeze, so the Mac keeps
# writing during the dump and an exact gate is impossible; instead the static tables (the list
# itself) must match, and the tables volunteers write to are reported with their drift.
# Useful before a cutover, and it makes tonight's S3 backup — taken from EC2 — a backup of the
# real data rather than of a stale rehearsal copy.
# ------------------------------------------------------------------------------------------------
sync() {
  say "sync — the Mac stays production; EC2's copy is replaced"
  remote 'true' || die "cannot reach $EC2"
  [ "$(remote 'systemctl is-active cloudflared 2>/dev/null || true')" = active ] && die "EC2's PRODUCTION connector is active — EC2 is not a copy any more; use rollback --with-data logic, not sync"
  [ "$(photos_local)" = 0 ] || die "sign photos exist on the Mac — pg_dump does not carry them and this script does not move the volume yet"
  confirm SYNC "This dumps the Mac's database now, copies it to EC2, and REPLACES EC2's database with it.
Production on the Mac is not touched. The staging URL keeps serving, with the new data."

  say "dump on the Mac (production keeps running)"
  counts_local > "backups/sync-$STAMP.mac.counts"
  make backup >/dev/null
  local dump; dump=$( { ls -t backups/canvass-*.sql.gz.gpg 2>/dev/null || true; } | head -1); [ -n "$dump" ] || die "make backup produced no file"
  local sha; sha=$(shasum -a 256 "$dump" | cut -d' ' -f1); ok "$dump  sha256 ${sha:0:16}…"

  say "copy"
  remote 'mkdir -p backups'; scp -q "$dump" "$EC2:$EC2_DIR/backups/"
  [ "$(remote "sha256sum backups/$(basename "$dump") | cut -d' ' -f1")" = "$sha" ] && ok "checksum matches on EC2" || die "checksum mismatch after copy"

  say "restore on EC2 (its API stopped for the duration)"
  remote "docker stop $API >/dev/null && make restore FILE=backups/$(basename "$dump") >/dev/null 2>&1" || { remote "docker start $API >/dev/null" || true; die "restore failed on EC2 — its API has been restarted"; }
  counts_remote > "backups/sync-$STAMP.ec2.counts"
  remote "docker start $API >/dev/null"
  wait_until "EC2 API healthy on the new data" 40 3 remote 'curl -fsS --max-time 5 http://127.0.0.1:3031/api/health' || die "EC2 API did not come back"

  say "compare"
  # The list itself never changes between the baseline and the dump unless an import ran: exact.
  local t bad_static=0
  for t in household voter import_run schema_migration; do
    local m e; m=$(grep "^$t|" "backups/sync-$STAMP.mac.counts" | cut -d'|' -f2); e=$(grep "^$t|" "backups/sync-$STAMP.ec2.counts" | cut -d'|' -f2)
    if [ "$m" = "$e" ]; then ok "$t: $e"; else bad "$t: Mac $m vs EC2 $e"; bad_static=1; fi
  done
  [ "$bad_static" = 0 ] || die "the voters list itself differs after the restore — do not trust this copy"
  # Everything volunteers write to keeps moving on the Mac; report it rather than gate on it.
  printf '  %-16s %8s %8s   %s\n' table mac ec2 note
  for t in contact sign sign_photo voter_contact turf turf_household app_user session audit_log public_request; do
    local m e; m=$(grep "^$t|" "backups/sync-$STAMP.mac.counts" | cut -d'|' -f2); e=$(grep "^$t|" "backups/sync-$STAMP.ec2.counts" | cut -d'|' -f2)
    [ -z "$m" ] && continue
    local note=""; [ "$m" != "$e" ] && note="(Mac moved on by $((m - e)) since the dump)"
    printf '  %-16s %8s %8s   %s\n' "$t" "$m" "$e" "$note"
  done
  say "synced"
  printf '  EC2 holds the Mac'"'"'s data as of %s. The Mac is still production; anything entered there from now on is not on EC2 until the next sync or the cutover.\n' "$(grep '^contact.latest|' "backups/sync-$STAMP.ec2.counts" | cut -d'|' -f2)"
  printf '  evidence: backups/sync-%s.{mac,ec2}.counts, log %s\n' "$STAMP" "$LOG"
}

# ------------------------------------------------------------------------------------------------
finish() {
  say "finish — only after production on AWS has been checked on a phone"
  local c; c=$(connectors)
  [ "$(printf '%s\n' "$c" | grep -c .)" = 1 ] && printf '%s' "$c" | grep -q '^linux' || die "production is not being served by exactly one linux connector — nothing to finish"
  [ "$(public_code finish)" = 200 ] || die "https://$PUBLIC_HOST is not answering 200"
  confirm FINISH "This disables the Mac's tunnel agent, DELETES the production tunnel credentials from this Mac
(EC2 keeps its copy; rollback fetches them back from there), repoints .env.dev at canvass_demo,
and removes the staging tunnel. The Mac's database container and its frozen data are kept as the rollback."

  launchctl disable "gui/$(id -u)/$AGENT" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/$AGENT" 2>/dev/null || true
  ok "LaunchAgent disabled — a reboot cannot bring the old connector back"
  # A Mac that still holds these is one launchctl away from becoming a second connector serving stale data.
  rm -f "$CREDS" && ok "production tunnel credentials removed from this Mac"
  docker stop "$API" "$CADDY" >/dev/null 2>&1 || true; ok "Mac API and Caddy stay stopped; the database container stays up for dev, demo and tests"

  if grep -Eq '^DATABASE_URL=.*/canvass([?].*)?$' .env.dev 2>/dev/null; then
    cp .env.dev ".env.dev.pre-cutover-$STAMP"
    sed -i '' -E 's#^(DATABASE_URL=.*/)canvass([?].*)?$#\1canvass_demo\2#' .env.dev
    ok ".env.dev now points at canvass_demo (was the real database; copy kept as .env.dev.pre-cutover-$STAMP)"
    docker exec "$DB" psql -U canvass -d postgres -Atc "select 1 from pg_database where datname='canvass_demo'" 2>/dev/null | grep -q 1 || warn "canvass_demo does not exist yet — run: make demo"
    warn "restart the dev API so it picks up the new DATABASE_URL"
  else ok ".env.dev does not point at the real database"; fi

  cloudflared tunnel delete -f "$STAGING_TUNNEL" >/dev/null 2>&1 && ok "staging tunnel deleted" || warn "could not delete the staging tunnel '$STAGING_TUNNEL' — remove it in the Cloudflare dashboard"
  remote "sudo rm -f /etc/systemd/system/cloudflared-staging.service /etc/cloudflared/staging.yml; sudo systemctl daemon-reload" || true
  cat <<NOTES

  Still yours to do:
   - Cloudflare DNS: the CNAME for $STAGING_HOST now dangles — delete it in the dashboard.
   - The frozen 'canvass' database on this Mac is the rollback. Keep it (FileVault on) until EC2 has run
     a couple of weeks and a restore-from-S3 has been tested; then drop it and record the date.
   - Add the EC2 instance, its volume and the S3 bucket to the s. 23(8) destruction inventory.
   - CLAUDE.md and the memory note still say production is this Mac.
NOTES
}

# ------------------------------------------------------------------------------------------------
rollback() {
  local with_data=${1:-}
  say "rollback — production back onto this Mac"
  local c; c=$(connectors); printf '%s\n' "$c" | sed 's/^/        connector: /'
  local ec2_live=0; printf '%s' "$c" | grep -q '^linux' && ec2_live=1

  if [ "$ec2_live" = 1 ] && [ "$with_data" != "--with-data" ]; then
    confirm ROLLBACK "EC2 is serving production RIGHT NOW. Anything recorded there since the cutover is NOT on this Mac.
Rolling back without --with-data DISCARDS it from production (it stays on EC2's disk, recoverable by hand).
If real canvassing has happened on AWS, stop and run:  ./scripts/cutover-aws.sh rollback --with-data"
  else
    confirm ROLLBACK "This stops EC2's connector (if any) and restarts the Mac's stack and tunnel."
  fi

  remote 'sudo systemctl disable --now cloudflared >/dev/null 2>&1 || true' || warn "could not reach EC2 to stop its connector"
  local i=0; while printf '%s' "$(connectors)" | grep -q '^linux' && [ $i -lt 20 ]; do sleep 3; i=$((i+1)); done
  printf '%s' "$(connectors)" | grep -q '^linux' && die "EC2's connector is still registered — NOT starting the Mac's (that would be split brain)"
  ok "EC2 is not connected to the production tunnel"

  if [ "$with_data" = "--with-data" ]; then
    say "bring EC2's data back"
    remote "docker stop $API >/dev/null; make backup >/dev/null" || die "backup on EC2 failed"
    local f; f=$(remote 'ls -t backups/canvass-*.sql.gz.gpg | head -1'); local sha; sha=$(remote "sha256sum $f | cut -d' ' -f1")
    scp -q "$EC2:$EC2_DIR/$f" backups/; [ "$(shasum -a 256 "backups/$(basename "$f")" | cut -d' ' -f1)" = "$sha" ] || die "checksum mismatch copying the dump back"
    counts_remote > "backups/rollback-$STAMP.ec2.counts"
    docker stop "$API" >/dev/null 2>&1 || true
    make restore FILE="backups/$(basename "$f")" >/dev/null 2>&1 || die "restore on the Mac failed — EC2's dump is at backups/$(basename "$f")"
    counts_local > "backups/rollback-$STAMP.mac.counts"
    diff "backups/rollback-$STAMP.ec2.counts" "backups/rollback-$STAMP.mac.counts" >/dev/null && ok "the Mac now holds exactly what EC2 had" || die "counts differ after the reverse restore — do not reopen the Mac yet"
  fi

  if [ ! -f "$CREDS" ]; then
    # finish deleted them from here on purpose; EC2 has kept its copy for exactly this.
    ssh -n -o BatchMode=yes "$EC2" "sudo cat /etc/cloudflared/$TUNNEL.json" > "$CREDS" && chmod 600 "$CREDS" && ok "tunnel credentials fetched back from EC2" || die "no tunnel credentials on this Mac and could not fetch them from EC2"
  fi
  unfreeze_mac
  wait_until "Mac API healthy" 40 3 curl -fsS --max-time 5 http://127.0.0.1:3031/api/health || die "the Mac's stack did not come up — try: make devdb"
  i=0; while ! printf '%s' "$(connectors)" | grep -q '^darwin' && [ $i -lt 20 ]; do sleep 3; i=$((i+1)); done
  printf '%s' "$(connectors)" | grep -q '^darwin' && ok "the Mac's connector is registered" || die "the Mac's connector did not register — run: launchctl kickstart -k gui/$(id -u)/$AGENT"
  i=0; while [ "$(public_code rollback)" != 200 ] && [ $i -lt 20 ]; do sleep 3; i=$((i+1)); done
  [ "$(public_code rollback)" = 200 ] && ok "https://$PUBLIC_HOST answers 200 from the Mac" || die "public hostname is not answering yet"
  say "rolled back"
  printf '  If the dev API was stopped by the cutover, restart it yourself. log: %s\n' "$LOG"
}

case "${1:-}" in
  preflight) preflight ;;
  prepare)   prepare ;;
  sync)      sync ;;
  cutover)   cutover ;;
  finish)    finish ;;
  rollback)  rollback "${2:-}" ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
