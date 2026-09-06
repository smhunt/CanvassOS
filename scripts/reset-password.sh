#!/usr/bin/env bash
# Issue a password-reset link for a user who cannot sign in.
#
#   ./scripts/reset-password.sh sean@ecoworks.ca
#   make reset-password EMAIL=sean@ecoworks.ca
#
# There is no email service in this stack, and self-serve "forgot password" needs one — so the
# operator (who has server access) mints the link and hands it over. It reuses the invite mechanism:
# a single-use token, valid 7 days, that lets the person set their own password. The password itself
# never passes through the operator, which is the point.
#
# Accepting the link clears every existing session for that user, so a stolen link cannot be used
# quietly alongside the real owner.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

EMAIL="${1:-${EMAIL:-}}"
[ -n "$EMAIL" ] || { echo "usage: $0 <email>   (or make reset-password EMAIL=...)" >&2; exit 1; }

# An explicit DOMAIN wins: the public hostname in .env is not reachable until the tunnel is up, so
# an operator resetting a password today needs to hand over a LAN address instead.
if [ -z "${DOMAIN:-}" ]; then
  DOMAIN="$(sed -n 's/^DOMAIN=//p' .env 2>/dev/null | tail -1)"
fi
DOMAIN="${DOMAIN:-localhost}"
PSQL="${PSQL:-docker compose exec -T db psql -U canvass -d canvass}"

TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
HASH="$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$TOKEN")"

# Only the hash is stored — the raw token exists solely in the URL printed below.
rows=$($PSQL -tAc "UPDATE app_user
                   SET invite_token = '$HASH', invite_expires = now() + interval '7 days'
                   WHERE email = '$EMAIL' AND active
                   RETURNING email" | tr -d '[:space:]')

if [ -z "$rows" ]; then
  echo "no active user with email '$EMAIL'" >&2
  exit 2
fi

echo
echo "Password reset link for $EMAIL — single use, valid 7 days:"
echo
echo "  https://$DOMAIN/invite/$TOKEN"
echo
echo "Send it to them directly. Opening it lets them set a new password and signs out"
echo "every other session they had. It does not reveal the old one — nobody can."
