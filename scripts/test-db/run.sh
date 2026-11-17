#!/usr/bin/env bash
# Local fallback for `supabase test db` when Docker images can't be pulled:
# builds a throwaway Postgres database with Supabase stand-ins, applies every
# migration in order, then runs the pgTAP tests. Needs psql, pg_prove and pgTAP.
#
#   scripts/test-db/run.sh            # uses the local postgres superuser
#   PGUSER=postgres scripts/test-db/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

DB="hd_test_$$"
export PGUSER="${PGUSER:-postgres}"
cleanup() { dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

createdb "$DB"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f scripts/test-db/supabase_stubs.sql
for f in supabase/migrations/*.sql; do
  echo "applying $f"
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
pg_prove -d "$DB" supabase/tests/*.sql
