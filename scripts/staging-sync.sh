#!/usr/bin/env bash
# Twice-daily staging refresh: restore the newest production backup from S3 into the Mac's `canvass`.
#
#   ./scripts/staging-sync.sh            run once, now (by hand, or `make staging-sync`)
#   ./scripts/staging-sync.sh scheduled  what launchd runs at 04:15 and 16:15 — see "no catch-up"
#   ./scripts/staging-sync.sh install    copy this script out of the repo and load the LaunchAgent
#   ./scripts/staging-sync.sh uninstall  unload it and remove the installed copy (dumps are left)
#   ./scripts/staging-sync.sh status     is it loaded, what was restored last, the log tail
#
# THIS IS A STAGING REFRESH, NOT REPLICATION. The copy is whatever EC2 last shipped to S3 when the
# refresh ran, so between refreshes it falls up to ~12 hours behind production — more if EC2's
# backups are only nightly. A rollback onto it loses everything recorded since that dump;
# `cutover-aws.sh rollback --with-data` takes a fresh dump for exactly that reason, and this script is
# not a substitute for it. It never touches a tunnel connector on either machine.
#
# DIRECTION IS FIXED BY CONSTRUCTION. Production is only ever *read*, and only through S3: there is
# no ssh in this file, no remote psql, no connection string. The one write goes through
# `docker exec` into the local container named below, and is refused unless that container belongs
# to this repo's compose project on a local Docker context. Inverting this script therefore cannot
# reach production — keep it that way; do not add an ssh leg "to save a hop".
#
# It refuses, every run, when the Mac looks like it is serving: the api container or a cloudflared
# process running here means a rollback happened, the Mac is production again, and a scheduled
# drop-and-recreate of its database would destroy live writes. It also refuses while anything is
# connected to `canvass`, and it restores in ONE transaction with ON_ERROR_STOP, so a failed restore
# exits non-zero and leaves the previous copy intact rather than half-dropped.
#
# NO CATCH-UP. launchd runs a calendar job that was missed while the Mac was asleep or off once, on
# wake. `scheduled` treats any start outside a $WINDOW_MIN-minute window after 04:15 or 16:15 as
# such a replay: it logs that it skipped and exits, and the next refresh is the next normal window.
# A missed refresh is never made up.
#
# Sign photos are not restored here. EC2's database dumps and its photos tarball are separate
# uploads, and photos ship with the 03:30 nightly only, so in an emergency the newest photos tarball
# can be up to a day older than the newest db/ dump. Nothing in the key names says so.
#
# Every refusal is loud (a macOS notification on each run it persists), and so is staleness: when the
# newest dump in S3 is more than $STALE_HOURS hours old, EC2 has stopped backing up.
#
# The log ($LOG) holds counts, S3 keys, times and durations — never a name, address or household id.
# It sits unencrypted on the Mac, so keep it that way. It rotates at 512 KB.
#
# The restored database is plaintext on the Mac's disk — the same posture the Mac had as production
# before 2026-09-24. Dumps in backups/staging/ are kept $RETAIN_DAYS days. `make purge` uninstalls this
# job and deletes the database volume, and lists backups/staging/ (dumps and log) for deletion.
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
# launchd runs the installed copy, which lives outside the repo, so the repo is named explicitly.
REPO="${CANVASS_REPO:-$(cd "$(dirname "$SELF")/.." && pwd)}"

LABEL=ca.ecoworks.canvass-staging-sync
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALL_DIR="$HOME/Library/Application Support/canvass-staging-sync"
# launchd's stderr only (stdout is already in $LOG) — a crash before log() is reachable lands here.
LAUNCHD_LOG="$HOME/Library/Logs/canvass-staging-sync.launchd.log"
LAUNCHD_PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

DB_CONTAINER=canvass-db-1
API_CONTAINER=canvass-api-1
DB_NAME="${CANVASS_SYNC_DB:-canvass}"   # override only to test against a throwaway database in the same container
STAGE_DIR="$REPO/backups/staging"
STATE="$STAGE_DIR/last-restored"
LOG="$STAGE_DIR/staging-sync.log"
RETAIN_DAYS=3
# 13, not less: with nightly-only EC2 backups the 16:15 run legitimately finds the 03:30 dump, and a
# missed nightly still trips it on the next 04:15.
STALE_HOURS=13
WINDOW_MIN=30

envval() { sed -n "s/^$1=//p" "$REPO/.env" 2>/dev/null | tail -1; }
log() { mkdir -p "$STAGE_DIR"; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }
fail() {
  log "FAILED: $*"
  osascript -e "display notification \"$*\" with title \"Canvass staging sync failed\"" >/dev/null 2>&1 || true
  exit 1
}
psql_in() { local db=$1; shift; docker exec -i "$DB_CONTAINER" psql -U canvass -d "$db" -At -v ON_ERROR_STOP=1 "$@"; }

cmd_scheduled() {
  local now=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))
  local w
  for w in $((4 * 60 + 15)) $((16 * 60 + 15)); do
    if [ "$now" -ge "$w" ] && [ "$now" -lt $((w + WINDOW_MIN)) ]; then cmd_run; return; fi
  done
  log "skip: started at $(date +%H:%M), outside the 04:15/16:15 windows — a missed run (Mac asleep or off) is not replayed"
}

cmd_run() {
  mkdir -p "$STAGE_DIR"
  if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG")" -gt 524288 ]; then mv -f "$LOG" "$LOG.1"; fi
  local started=$SECONDS
  log "start"
  # A slow download must not overlap the next run. mkdir is atomic; a stale lock from a
  # crashed run is cleared once it is older than the interval.
  local lock="$STAGE_DIR/.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$lock"; mkdir "$lock"
    else log "skip: previous run still going"; return 0; fi
  fi
  trap 'rmdir "$STAGE_DIR/.lock" 2>/dev/null || true' EXIT
  trap 'fail "unexpected error at line $LINENO"' ERR

  # ---- direction guard: the only write target is this repo's local db container
  [ -z "${DOCKER_HOST:-}" ] || fail "DOCKER_HOST is set ($DOCKER_HOST) — refusing to restore anywhere but the local Docker"
  docker info >/dev/null 2>&1 || fail "Docker is not running"
  local wd; wd="$(docker inspect "$DB_CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null)" \
    || fail "no $DB_CONTAINER container — is the Mac stack up (make devdb)?"
  [ "$wd" = "$REPO" ] || fail "$DB_CONTAINER belongs to $wd, not $REPO — refusing"

  # ---- the Mac must not be serving
  [ -z "$(docker ps -q --filter "name=^${API_CONTAINER}\$" --filter status=running)" ] \
    || fail "$API_CONTAINER is running on the Mac — it may be production again (rollback?); not overwriting its database"
  ! pgrep -x cloudflared >/dev/null || fail "cloudflared is running on the Mac — it may be serving production; not overwriting its database"

  # ---- newest dump in S3 (keys are timestamped, so lexical order is time order)
  local s3="${BACKUP_S3_URI:-$(envval BACKUP_S3_URI)}"; s3="${s3:-s3://canvass-backups-910075288629}"; s3="${s3%/}"
  local bucket="${s3#s3://}"
  local aws=(aws --profile "${AWS_PROFILE:-eco}" --region "${AWS_REGION:-ca-central-1}")
  local key
  key="$("${aws[@]}" s3api list-objects-v2 --bucket "$bucket" --prefix db/canvass- \
          --query 'sort_by(Contents, &Key)[-1].Key' --output text)" || fail "cannot list $s3/db/"
  case "$key" in db/canvass-*.sql.gz.gpg) ;; *) fail "no dump found in $s3/db/ (got '$key')" ;; esac
  local stamp="${key#db/canvass-}"; stamp="${stamp%.sql.gz.gpg}"
  local age_h=$(( ( $(date +%s) - $(date -j -f %Y%m%d-%H%M%S "$stamp" +%s) ) / 3600 ))
  [ "$age_h" -lt "$STALE_HOURS" ] || fail "newest dump in S3 is ${age_h}h old ($key) — EC2 has stopped backing up"
  log "newest in S3: $key (${age_h}h old)"
  local last; last="$(cat "$STATE" 2>/dev/null || true)"
  if [ "$last" = "$key" ]; then log "skip: already restored $key"; return 0; fi
  # Never go backwards: a copy restored by hand can be newer than anything in the bucket.
  if [ -n "$last" ] && [[ "$key" < "$last" ]]; then log "skip: $key is older than the copy already restored ($last)"; return 0; fi

  # ---- nobody may be using the database we are about to replace
  local busy; busy="$(psql_in postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$DB_NAME'")"
  [ "$busy" = 0 ] || fail "$busy session(s) connected to $DB_NAME — not restoring under them"

  local file="$STAGE_DIR/$(basename "$key")"
  "${aws[@]}" s3 cp --only-show-errors "$s3/$key" "$file" || fail "download of $key failed"
  local want; want="$("${aws[@]}" s3api head-object --bucket "$bucket" --key "$key" --query ContentLength --output text)"
  [ "$(stat -f %z "$file")" = "$want" ] || fail "$key downloaded short ($(stat -f %z "$file") of $want bytes)"

  local pass; pass="$(envval BACKUP_PASSPHRASE)"; [ -n "$pass" ] || fail "BACKUP_PASSPHRASE missing from $REPO/.env"
  local migrations_before; migrations_before="$(psql_in "$DB_NAME" -c 'SELECT count(*) FROM schema_migration' 2>/dev/null || echo 0)"
  local audit_before; audit_before="$(psql_in "$DB_NAME" -c "SELECT coalesce(max(at), 'epoch') FROM audit_log" 2>/dev/null || echo epoch)"

  # One transaction: a bad dump rolls back and leaves the previous copy in place. The
  # passphrase goes over an fd, not argv, so it never appears in `ps`.
  gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 -d "$file" 3<<<"$pass" \
    | gunzip \
    | docker exec -i "$DB_CONTAINER" psql -U canvass -d "$DB_NAME" -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null \
    || fail "restore of $key failed — rolled back, previous copy kept"

  local voters households migrations_after
  voters="$(psql_in "$DB_NAME" -c 'SELECT count(*) FROM voter')"
  households="$(psql_in "$DB_NAME" -c 'SELECT count(*) FROM household')"
  migrations_after="$(psql_in "$DB_NAME" -c 'SELECT count(*) FROM schema_migration')"
  [ "$voters" -gt 0 ] && [ "$households" -gt 0 ] || fail "restored $key but it looks empty ($households households, $voters voters)"
  [ "$migrations_after" -ge "$migrations_before" ] \
    || fail "restored $key has fewer migrations ($migrations_after) than the copy it replaced ($migrations_before)"
  # Content, not just exit codes: the newest audit row must not go backwards. A restore that quietly
  # did nothing would leave the previous copy in place and pass every non-zero check above.
  local went_back; went_back="$(psql_in "$DB_NAME" -c "SELECT (SELECT max(at) FROM audit_log) < '$audit_before'::timestamptz")"
  [ "$went_back" = f ] || fail "restored $key but its newest audit row is older than the copy it replaced"
  local counts
  counts="$(psql_in "$DB_NAME" -c "SELECT '$households households, $voters voters, ' || (SELECT count(*) FROM contact) || ' contacts, ' || (SELECT count(*) FROM sign) || ' signs, $migrations_after migrations'")"

  printf '%s\n' "$key" > "$STATE"
  log "restored $key in $((SECONDS - started))s: $counts; the copy is ${age_h}h behind production"

  # Retention: $RETAIN_DAYS days. Everything here is the voters list.
  find "$STAGE_DIR" -maxdepth 1 -name 'canvass-*.sql.gz.gpg' -mmin +$((RETAIN_DAYS * 24 * 60)) -print \
    | while read -r old; do rm -f "$old"; log "pruned $(basename "$old")"; done
}

cmd_install() {
  [ -f "$REPO/.env" ] || { echo "no $REPO/.env — run install from the main checkout, or set CANVASS_REPO" >&2; exit 1; }
  mkdir -p "$INSTALL_DIR" "$(dirname "$PLIST")" "$(dirname "$LAUNCHD_LOG")" "$STAGE_DIR"
  cp "$SELF" "$INSTALL_DIR/staging-sync.sh"; chmod 755 "$INSTALL_DIR/staging-sync.sh"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$INSTALL_DIR/staging-sync.sh</string><string>scheduled</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$LAUNCHD_PATH</string>
    <key>CANVASS_REPO</key><string>$REPO</string>
  </dict>
  <!-- 04:15 is after EC2's 03:30 nightly. A time missed while the Mac was asleep fires once on
       wake; the scheduled mode logs that and skips it, so nothing is replayed. -->
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>15</integer></dict>
    <dict><key>Hour</key><integer>16</integer><key>Minute</key><integer>15</integer></dict>
  </array>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$LAUNCHD_LOG</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "installed: $LABEL runs at 04:15 and 16:15 against $REPO (log: $LOG)"
}

cmd_uninstall() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"; rm -rf "$INSTALL_DIR"
  echo "uninstalled $LABEL (dumps in $STAGE_DIR left in place)"
}

cmd_status() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "loaded: $LABEL"; else echo "NOT loaded: $LABEL"; fi
  if [ -f "$INSTALL_DIR/staging-sync.sh" ] && ! cmp -s "$INSTALL_DIR/staging-sync.sh" "$SELF"; then
    echo "note: the installed copy differs from $SELF — re-run install to pick up changes"
  fi
  echo "last restored: $(cat "$STATE" 2>/dev/null || echo none)"
  tail -8 "$LOG" 2>/dev/null || true
}

case "${1:-run}" in
  run) cmd_run ;;
  scheduled) cmd_scheduled ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  *) echo "usage: $0 [run|scheduled|install|uninstall|status]" >&2; exit 2 ;;
esac
