#!/usr/bin/env bash
# Encrypted backup to S3. Runs `make backup`, ships the result off the box, and proves it landed.
#
#   ./scripts/backup-offsite.sh
#   30 3 * * * cd /srv/canvass && ./scripts/backup-offsite.sh >> /var/log/canvass-backup.log 2>&1
#
# Why this exists: `make backup` writes to backups/ ON THE SAME HOST as the database, so until this
# ran there was no copy that survived losing the box. A backup sharing a failure domain with the
# thing it backs up is not a backup.
#
# Two things are backed up, because pg_dump only covers one of them:
#   - the database (make backup -> pg_dump | gzip | gpg AES256)
#   - the signphotos VOLUME, which holds photographs of electors' houses and is not in the dump.
#     Empty today; the moment a volunteer uploads one photo a database-only backup is silently
#     incomplete and that photo is unrecoverable.
#
# Everything is GPG-encrypted with BACKUP_PASSPHRASE *before* it leaves the host, so S3 never sees
# plaintext personal information. Keep the passphrase somewhere other than this server.
#
# The instance role deliberately has no s3:DeleteObject — a compromised box must not be able to
# destroy the only off-site copies. Retention is enforced by the bucket lifecycle rule (30 days),
# and `make purge-offsite` (which needs admin credentials, not the instance role) is what destroys
# them after the election.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

envval() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -1; }

S3_URI="${BACKUP_S3_URI:-$(envval BACKUP_S3_URI)}"
[ -n "$S3_URI" ] || { echo "set BACKUP_S3_URI in .env (e.g. s3://canvass-backups-<account>)" >&2; exit 1; }
S3_URI="${S3_URI%/}"

PASS="$(envval BACKUP_PASSPHRASE)"
[ -n "$PASS" ] || { echo "set BACKUP_PASSPHRASE in .env" >&2; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
# On EC2 the instance role supplies credentials; AWS_PROFILE is only needed when running from a
# workstation. Both paths land on the same `aws` invocation.
AWS=(aws ${AWS_PROFILE:+--profile "$AWS_PROFILE"} ${AWS_REGION:+--region "$AWS_REGION"})

# ---------------------------------------------------------------- database
make backup
DUMP="$(ls -t "$BACKUP_DIR"/canvass-*.sql.gz.gpg 2>/dev/null | head -1)"
[ -n "$DUMP" ] || { echo "make backup produced no file in $BACKUP_DIR" >&2; exit 1; }

"${AWS[@]}" s3 cp "$DUMP" "$S3_URI/db/$(basename "$DUMP")"
# Verify rather than trust the exit code: a silent no-op upload is the failure mode that leaves you
# believing you have backups you do not have.
"${AWS[@]}" s3api head-object --bucket "${S3_URI#s3://}" --key "db/$(basename "$DUMP")" >/dev/null
echo "verified: $S3_URI/db/$(basename "$DUMP")"

# ---------------------------------------------------------------- sign photos
# Skip when the volume is empty, or a 45-day campaign accumulates 45 identical empty tarballs.
PHOTO_VOL="${PHOTO_VOL:-canvass_signphotos}"
if docker volume inspect "$PHOTO_VOL" >/dev/null 2>&1; then
  COUNT="$(docker run --rm -v "$PHOTO_VOL":/photos:ro alpine sh -c 'find /photos -type f | wc -l' | tr -d '[:space:]')"
  if [ "${COUNT:-0}" -gt 0 ]; then
    PHOTOS="$BACKUP_DIR/signphotos-$STAMP.tar.gz.gpg"
    docker run --rm -v "$PHOTO_VOL":/photos:ro alpine tar -C /photos -cf - . \
      | gzip -9 \
      | gpg --batch --yes --symmetric --cipher-algo AES256 --pinentry-mode loopback \
            --passphrase "$PASS" -o "$PHOTOS"
    "${AWS[@]}" s3 cp "$PHOTOS" "$S3_URI/photos/$(basename "$PHOTOS")"
    "${AWS[@]}" s3api head-object --bucket "${S3_URI#s3://}" --key "photos/$(basename "$PHOTOS")" >/dev/null
    echo "verified: $S3_URI/photos/$(basename "$PHOTOS") ($COUNT photos)"
  else
    echo "signphotos volume empty — nothing to ship"
  fi
else
  echo "no $PHOTO_VOL volume — nothing to ship"
fi

# ---------------------------------------------------------------- local retention
# Matches the rotation the README documented for the local-only cron.
find "$BACKUP_DIR" -name '*.gpg' -mtime +14 -print -delete
