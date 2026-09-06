#!/usr/bin/env bash
# Apply any db/migrations/*.sql not yet recorded in schema_migration, in filename order.
#
# db/schema.sql is only ever applied to an EMPTY database, by the postgres image's
# docker-entrypoint-initdb.d hook on first boot. Once a stack carries real data every schema change
# has to arrive as a migration instead — that is what this is.
#
#   ./db/migrate.sh            apply pending migrations
#   ./db/migrate.sh status     list applied / pending
#
# Runs on the HOST (the .sql files live here) and reaches the database through docker compose by
# default. Override PSQL to point somewhere else, e.g. a local psql for the test database:
#   PSQL="psql postgresql://canvass:pw@localhost:5443/canvass_test" ./db/migrate.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
MIG_DIR="db/migrations"
MODE="${1:-apply}"
: "${PSQL:=docker compose exec -T db psql -U canvass -d canvass}"

run() { $PSQL -v ON_ERROR_STOP=1 -q "$@"; }

run -c "CREATE TABLE IF NOT EXISTS schema_migration (
  name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" >/dev/null

applied="$(run -tAc 'SELECT name FROM schema_migration' | tr -d '\r')"

pending=()
for f in "$MIG_DIR"/*.sql; do
  [ -e "$f" ] || continue
  grep -qxF "$(basename "$f")" <<<"$applied" || pending+=("$f")
done

if [ "$MODE" = "status" ]; then
  echo "applied:"; [ -n "$applied" ] && sed 's/^/  /' <<<"$applied" || echo "  (none)"
  echo "pending:"; [ ${#pending[@]} -eq 0 ] && echo "  (none)" || printf '  %s\n' "${pending[@]##*/}"
  exit 0
fi

[ ${#pending[@]} -eq 0 ] && { echo "no pending migrations"; exit 0; }

for f in "${pending[@]}"; do
  name="$(basename "$f")"
  echo "applying $name"
  # The migration and its bookkeeping row commit together, so a failure leaves nothing half-applied.
  { echo 'BEGIN;'; cat "$f"
    echo; echo "INSERT INTO schema_migration (name) VALUES ('$name');"; echo 'COMMIT;'; } | run
done
echo "done"
