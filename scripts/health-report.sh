#!/usr/bin/env bash
# Daily health report for the production stack on AWS.
#
#   ./scripts/health-report.sh run        collect and print the report now
#   ./scripts/health-report.sh scheduled  what launchd runs at 08:00 — see "no catch-up"
#   ./scripts/health-report.sh install    copy this script out of the repo and load the LaunchAgent
#   ./scripts/health-report.sh uninstall  unload it and remove the installed copy (the log is left)
#   ./scripts/health-report.sh status     is it loaded, and the last report
#
# READ-ONLY, AND THAT IS THE WHOLE CONTRACT. Every remote command below reads: uptime, free, df,
# docker ps/inspect/logs, aws s3 ls. Nothing writes, restarts, prunes or deploys. A health check
# that can change the thing it is checking turns a quiet morning into an outage, so if you are
# tempted to add `docker builder prune` here because the report keeps mentioning the build cache:
# don't. Report it, let a person decide. (`staging-sync.sh` forbids an ssh leg for the opposite
# reason — it *writes*, so it must never be able to reach production. This one only reads, so ssh
# is fine; the two rules are not in conflict.)
#
# NO CATCH-UP. launchd runs a missed calendar job once, on wake. `scheduled` treats any start
# outside a $WINDOW_MIN-minute window after $REPORT_HOUR as that replay: it logs the skip and
# exits. Yesterday's health is not news, and a notification that fires because the lid was shut is
# how somebody learns to swipe these away without reading them.
#
# The report carries COUNTS AND STATUS ONLY — never a name, an address or a household id. It sits
# unencrypted on this Mac and is read at a glance over coffee; nothing from the voters list
# belongs in it. See the Municipal Elections Act s.23(7)-(8) notes in README.md.
set -uo pipefail

REMOTE="${CANVASS_REMOTE:-canvass-prod}"
REMOTE_DIR="${CANVASS_REMOTE_DIR:-/srv/canvass}"
PUBLIC_URL="${CANVASS_PUBLIC_URL:-https://canvass.webarchitecture.ca}"
BUCKET="${CANVASS_BUCKET:-canvass-backups-910075288629}"

INSTALL_DIR="$HOME/Library/Application Support/canvass-health-report"
LABEL="ca.ecoworks.canvass-health-report"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/canvass-health-report.log"
STAGING_LOG="${CANVASS_STAGING_LOG:-$HOME/Code/mc-canvass/backups/staging/staging-sync.log}"
REPORT_HOUR=8
WINDOW_MIN=30

# Thresholds. Each one is a number somebody will want to argue with later, so the reasoning is
# here rather than in a commit message.
DISK_WARN_PCT=75          # 29 GB disk; at 75% there is still a week of headroom to act in.
BACKUP_MAX_AGE_H=26       # the nightly runs at 03:30. 26h = one missed run, plus grace for a slow
                          # dump. Tighter than this and normal jitter cries wolf.
STAGING_MAX_AGE_H=26      # the Mac restores at 04:15 from that nightly, so it tracks the same clock.
BUILDCACHE_WARN_GB=2      # docker build cache is the one thing here that grows without a cap.
ERR_WARN=0                # any error-level line in the API log is worth a human look.
HTTP5XX_WARN=5            # a deploy produces one or two 502s as the API container is replaced.

ALARMS=()
alarm() { ALARMS+=("$1"); }
say()   { printf '%s\n' "$*"; }

collect() {
  # ONE ssh round trip: a daily job that opens six connections is six chances to hang on a flaky
  # link, and SSM sessions are not instant to set up. Everything is tab-separated key/value.
  # NOT `ssh -n` here: -n points stdin at /dev/null, which silently eats the heredoc and the
  # remote bash reads an empty script. The report then says "unreachable" about a healthy box.
  ssh -o BatchMode=yes -o ConnectTimeout=30 "$REMOTE" bash -s <<REMOTE_SCRIPT 2>/dev/null
set -uo pipefail
cd "$REMOTE_DIR" 2>/dev/null || exit 9
C="docker compose -f docker-compose.yml -f docker-compose.tunnel.yml"

printf 'load\t%s\n' "\$(uptime | sed 's/.*load average[s]*: //')"
printf 'mem_used_mb\t%s\n' "\$(free -m | awk '/^Mem:/{print \$3}')"
printf 'mem_total_mb\t%s\n' "\$(free -m | awk '/^Mem:/{print \$2}')"
printf 'disk_pct\t%s\n' "\$(df / | awk 'NR==2{gsub(/%/,"",\$5); print \$5}')"
printf 'disk_avail\t%s\n' "\$(df -h / | awk 'NR==2{print \$4}')"
printf 'uptime_d\t%s\n' "\$(uptime | sed -n 's/.*up \\([^,]*\\),.*/\\1/p')"

for n in canvass-api-1 canvass-db-1 canvass-caddy-1; do
  printf 'container\t%s\t%s\t%s\n' "\$n" \
    "\$(docker inspect -f '{{.State.Status}}' \$n 2>/dev/null || echo missing)" \
    "\$(docker inspect -f '{{.RestartCount}}' \$n 2>/dev/null || echo ?)"
done

printf 'api_errors\t%s\n' "\$(\$C logs api --since 24h 2>/dev/null | grep -cE '"level":(50|60)')"
# Caddy's access log is `format console`, so only its ERROR entries carry a JSON "status". That
# makes this a count of 5xx, not a ratio — there is no denominator to be had without changing the
# Caddyfile, and a log format is not worth churning for a nicer number in a daily report.
printf 'http_5xx\t%s\n'   "\$(\$C logs caddy --since 24h 2>/dev/null | grep -cE '"status":5[0-9][0-9]')"
printf 'commit\t%s\n'     "\$(git log --oneline -1 2>/dev/null)"

# Backups: newest object, its age and whether it grew. A dump that stops growing is the shape of a
# silently broken backup — the campaign keeps canvassing, so the file should keep getting bigger.
aws s3 ls "s3://$BUCKET/db/" 2>/dev/null | sort | tail -2 | awk '{print "backup\t" \$1" "\$2"\t"\$3"\t"\$4}'
aws s3 ls "s3://$BUCKET/photos/" 2>/dev/null | sort | tail -1 | awk '{print "photos\t" \$1" "\$2"\t"\$3"\t"\$4}'

# "Build Cache" is a TWO-WORD type, so the RECLAIMABLE column is \$6, not \$4. Reading \$4 gives the
# ACTIVE count — which is 0 on an idle box, so the check silently never fired.
printf 'buildcache\t%s\n' "\$(docker system df 2>/dev/null | awk '/^Build Cache/{print \$6}')"
REMOTE_SCRIPT
}

report() {
  local raw; raw="$(collect)"; local rc=$?
  local now; now="$(date '+%Y-%m-%d %H:%M')"

  if [ -z "$raw" ] || [ "$rc" -ne 0 ]; then
    alarm "could not reach $REMOTE — the box, SSM, or this Mac's network"
    say "CanvassOS health — $now"
    say "  UNREACHABLE: ssh $REMOTE returned nothing (exit $rc)."
    say "  That is not necessarily an outage; check $PUBLIC_URL before assuming the worst."
    return
  fi

  local get; get() { printf '%s\n' "$raw" | awk -F'\t' -v k="$1" '$1==k{print $2; exit}'; }

  local load mem_u mem_t disk avail up commit errs x5 bc
  load="$(get load)"; mem_u="$(get mem_used_mb)"; mem_t="$(get mem_total_mb)"
  disk="$(get disk_pct)"; avail="$(get disk_avail)"; up="$(get uptime_d)"
  commit="$(get commit)"; errs="$(get api_errors)"; x5="$(get http_5xx)"
  bc="$(get buildcache)"

  # The public URL is checked from HERE, not from the box: the origin can be perfectly healthy
  # while the tunnel is down, and that is exactly the failure a canvasser would hit first.
  local edge; edge="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_URL/api/health" 2>/dev/null)"
  [ "$edge" = 200 ] || alarm "$PUBLIC_URL/api/health returned ${edge:-no response}"

  say "CanvassOS health — $now"
  say ""
  say "  edge        $PUBLIC_URL -> ${edge:-dead}"
  say "  deployed    ${commit:-unknown}"
  say "  uptime      ${up:-?}   load ${load:-?}"
  say "  memory      ${mem_u:-?} MB of ${mem_t:-?} MB"
  say "  disk        ${disk:-?}% used, ${avail:-?} free"

  [ -n "$disk" ] && [ "$disk" -ge "$DISK_WARN_PCT" ] 2>/dev/null \
    && alarm "disk at ${disk}% (warn at ${DISK_WARN_PCT}%)"

  say ""
  printf '%s\n' "$raw" | awk -F'\t' '$1=="container"{printf "  %-16s %-8s restarts=%s\n", $2, $3, $4}'
  while IFS=$'\t' read -r _ name state restarts; do
    [ "$state" = running ] || alarm "container $name is $state"
    [ "${restarts:-0}" = 0 ] || alarm "container $name has restarted $restarts time(s)"
  done < <(printf '%s\n' "$raw" | awk -F'\t' '$1=="container"')

  say ""
  say "  api errors  ${errs:-?} (24h)"
  say "  http 5xx    ${x5:-?} (24h)"
  [ -n "$errs" ] && [ "$errs" -gt "$ERR_WARN" ] 2>/dev/null && alarm "${errs} error-level API log lines in 24h"
  [ -n "$x5" ] && [ "$x5" -gt "$HTTP5XX_WARN" ] 2>/dev/null && alarm "${x5} HTTP 5xx in 24h"

  # ---- backups
  say ""
  local newest newest_sz newest_when prev_sz
  newest="$(printf '%s\n' "$raw" | awk -F'\t' '$1=="backup"' | tail -1)"
  prev_sz="$(printf '%s\n' "$raw" | awk -F'\t' '$1=="backup"' | head -1 | cut -f3)"
  if [ -z "$newest" ]; then
    alarm "no database backup found in s3://$BUCKET/db/"
    say "  backup      NONE FOUND"
  else
    newest_when="$(printf '%s' "$newest" | cut -f2)"
    newest_sz="$(printf '%s' "$newest" | cut -f3)"
    local age_h; age_h="$(age_hours "$newest_when")"
    say "  backup      $(printf '%s' "$newest" | cut -f4)"
    say "              ${age_h}h old, $(human "$newest_sz")"
    [ "$age_h" -le "$BACKUP_MAX_AGE_H" ] 2>/dev/null \
      || alarm "newest database backup is ${age_h}h old (expect one every 24h)"
    if [ -n "$prev_sz" ] && [ "$newest_sz" -lt "$prev_sz" ] 2>/dev/null; then
      alarm "backup SHRANK: $(human "$prev_sz") -> $(human "$newest_sz") — a dump that stops growing while canvassing continues is the shape of a broken backup"
    fi
  fi
  local ph; ph="$(printf '%s\n' "$raw" | awk -F'\t' '$1=="photos"' | tail -1)"
  [ -n "$ph" ] && say "  photos      $(printf '%s' "$ph" | cut -f4) ($(human "$(printf '%s' "$ph" | cut -f3)"))"

  # ---- the Mac's staging copy
  if [ -f "$STAGING_LOG" ]; then
    local last; last="$(grep -E 'restored ' "$STAGING_LOG" | tail -1)"
    if [ -n "$last" ]; then
      local when; when="$(printf '%s' "$last" | awk '{print $1" "$2}')"
      local sage; sage="$(age_hours "$when")"
      say "  staging     last restored ${sage}h ago"
      [ "$sage" -le "$STAGING_MAX_AGE_H" ] 2>/dev/null \
        || alarm "the Mac's staging copy has not refreshed in ${sage}h — a rollback would lose that much"
    else
      say "  staging     no restore recorded yet"
    fi
  fi

  [ -n "$bc" ] && say "  buildcache  $bc reclaimable (docker builder prune)"
  case "$bc" in
    *GB) local n=${bc%GB}; awk -v n="${n:-0}" -v w="$BUILDCACHE_WARN_GB" 'BEGIN{exit !(n+0>w)}' \
           && alarm "docker build cache is $bc — prune it before it crowds the disk" ;;
  esac
}

# Whole hours between an ISO-ish "YYYY-MM-DD HH:MM[:SS]" and now. BSD date on macOS, so -j -f.
age_hours() {
  local then; then="$(date -j -f '%Y-%m-%d %H:%M:%S' "${1}:00" '+%s' 2>/dev/null \
                   || date -j -f '%Y-%m-%d %H:%M:%S' "$1" '+%s' 2>/dev/null)"
  [ -n "$then" ] || { echo 999; return; }
  echo $(( ( $(date '+%s') - then ) / 3600 ))
}

human() { awk -v b="${1:-0}" 'BEGIN{ if (b>1048576) printf "%.1f MB", b/1048576; else printf "%.0f KB", b/1024 }'; }

notify() {
  # osascript, not terminal-notifier: nothing to install, and it survives a bare login shell.
  # The text is passed as argv rather than interpolated into the AppleScript — ${x@Q} would be
  # tidier but needs bash 4.4, and launchd runs this with /bin/bash, which on macOS is 3.2.
  osascript - "$1" "$2" >/dev/null 2>&1 <<'OSA' || true
on run argv
  display notification (item 2 of argv) with title (item 1 of argv)
end run
OSA
}

cmd_run() {
  local out; out="$(report)"
  printf '%s\n' "$out"
  {
    printf '\n===== %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')"
    printf '%s\n' "$out"
    [ ${#ALARMS[@]} -gt 0 ] && printf 'ALARM: %s\n' "${ALARMS[@]}"
  } >> "$LOG"
  # Keep the log readable rather than complete; the authority is the box, not this file.
  [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt 524288 ] && tail -c 262144 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

  if [ ${#ALARMS[@]} -gt 0 ]; then
    printf '\n'; printf '  ALARM: %s\n' "${ALARMS[@]}"
    notify "CanvassOS: ${#ALARMS[@]} thing(s) to look at" "${ALARMS[0]}"
    return 1
  fi
  # One line a person can read off the lock screen without opening anything. The detail is in the
  # printed report and the log; this is only the verdict.
  notify "CanvassOS is healthy" "$(printf '%s' "$out" | awk '
    /^  disk /     {d=$2" "$3}
    /^  backup  /  {getline; sub(/^ +/,""); b=$0}
    END {printf "disk %s, newest backup %s", d, b}')"
  return 0
}

cmd_scheduled() {
  local now w; now=$(( $(date '+%H') * 60 + $(date '+%M') ))
  w=$(( REPORT_HOUR * 60 ))
  if [ "$now" -ge "$w" ] && [ "$now" -lt $(( w + WINDOW_MIN )) ]; then
    cmd_run; return $?
  fi
  printf '%s skip: started at %s, outside the %02d:00 window — a missed run (Mac asleep or off) is not replayed\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$(date '+%H:%M')" "$REPORT_HOUR" >> "$LOG"
}

cmd_install() {
  mkdir -p "$INSTALL_DIR" "$(dirname "$LOG")" "$HOME/Library/LaunchAgents"
  cp "$0" "$INSTALL_DIR/health-report.sh"; chmod +x "$INSTALL_DIR/health-report.sh"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$INSTALL_DIR/health-report.sh</string><string>scheduled</string></array>
  <key>StartCalendarInterval</key>
  <array><dict><key>Hour</key><integer>$REPORT_HOUR</integer><key>Minute</key><integer>0</integer></dict></array>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/canvass-health-report.launchd.log</string>
</dict></plist>
PLIST_EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" || { echo "could not load $PLIST" >&2; exit 1; }
  echo "installed: $INSTALL_DIR/health-report.sh"
  echo "scheduled: $(printf '%02d:00' "$REPORT_HOUR") daily (no catch-up); log $LOG"
}

cmd_uninstall() {
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"; rm -rf "$INSTALL_DIR"
  echo "uninstalled; $LOG left in place"
}

cmd_status() {
  launchctl list 2>/dev/null | grep -q "$LABEL" && echo "LaunchAgent: loaded" || echo "LaunchAgent: NOT loaded"
  [ -f "$LOG" ] && { echo "--- last report ---"; awk '/^===== /{p=NR} {l[NR]=$0} END{for(i=p;i<=NR;i++) print l[i]}' "$LOG"; } \
                || echo "no report yet"
}

case "${1:-run}" in
  run)       cmd_run ;;
  scheduled) cmd_scheduled ;;
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  *) echo "usage: $0 {run|scheduled|install|uninstall|status}" >&2; exit 2 ;;
esac
