#!/usr/bin/env bash
# Migrate the `public` schema from SOURCE to TARGET Postgres.
#
# Usage: migrate-data.sh SOURCE_URL TARGET_URL [--force]
#
# Requires pg_dump, pg_restore and psql (v16) on PATH. (Chosen over `docker run postgres:16`
# wrappers so URLs with localhost / private IPs behave exactly like the host.)
# On Debian/Ubuntu: apt install postgresql-client-16.
#
# The SOURCE is only ever read: read-only psql queries and pg_dump.
set -euo pipefail

FORCE=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--force" ]; then FORCE=1; else ARGS+=("$a"); fi
done
if [ "${#ARGS[@]}" -ne 2 ]; then
  echo "Usage: $0 SOURCE_URL TARGET_URL [--force]" >&2
  exit 2
fi
SOURCE_URL="${ARGS[0]}"
TARGET_URL="${ARGS[1]}"

for bin in pg_dump pg_restore psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin not found on PATH (need v16 client tools)" >&2; exit 2; }
done

# Every query against the source runs in a read-only session.
src_psql() { PGOPTIONS='-c default_transaction_read_only=on' psql "$SOURCE_URL" -X -v ON_ERROR_STOP=1 -At "$@"; }
dst_psql() { psql "$TARGET_URL" -X -v ON_ERROR_STOP=1 -At "$@"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- (1) Supabase-specific dependencies (schema auth) ---------------------------------------
echo "==> [1/4] Checking for objects that depend on schema 'auth' in SOURCE"
WARN="$WORK/warnings.txt"
: > "$WARN"
src_psql -c "SELECT 'POLICY   ' || schemaname || '.' || tablename || ' :: ' || policyname
             FROM pg_policies
             WHERE schemaname = 'public'
               AND (coalesce(qual,'') ILIKE '%auth.%' OR coalesce(with_check,'') ILIKE '%auth.%')" >> "$WARN"
src_psql -c "SELECT 'FUNCTION ' || n.nspname || '.' || p.proname
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prokind IN ('f','p') AND p.prosrc ILIKE '%auth.%'" >> "$WARN"
src_psql -c "SELECT 'VIEW     ' || schemaname || '.' || viewname
             FROM pg_views
             WHERE schemaname = 'public' AND definition ILIKE '%auth.%'" >> "$WARN"

if [ -s "$WARN" ]; then
  echo "WARNING: the following objects reference schema 'auth' (Supabase-only; it is NOT migrated):" >&2
  sed 's/^/  - /' "$WARN" >&2
  if [ "$FORCE" -ne 1 ]; then
    echo "Stopping. Review them, then re-run with --force to continue." >&2
    exit 1
  fi
  echo "--force given: continuing despite warnings." >&2
else
  echo "    none found"
fi

# --- (2) Dump ---------------------------------------------------------------------------------
DUMP="$WORK/public.dump"
echo "==> [2/4] pg_dump -Fc (schema public) from SOURCE"
pg_dump -Fc --no-owner --no-acl -n public -f "$DUMP" "$SOURCE_URL"

# --- (3) Restore ------------------------------------------------------------------------------
echo "==> [3/4] pg_restore into TARGET"
set +e
pg_restore --no-owner --no-acl -d "$TARGET_URL" "$DUMP"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  echo "WARNING: pg_restore exited $RC (commonly harmless, e.g. 'schema \"public\" already exists')." >&2
  echo "         Row-count verification below decides success." >&2
fi

# --- (4) Verify row counts --------------------------------------------------------------------
echo "==> [4/4] Comparing row counts per table in public"
count_rows() { # $1 = psql function name
  local fn="$1" t
  while IFS= read -r t; do
    [ -z "$t" ] && continue
    printf '%s\t%s\n' "$t" "$("$fn" -c "SELECT count(*) FROM public.\"$t\"")"
  done < <("$fn" -c "SELECT table_name FROM information_schema.tables
                     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")
}
count_rows src_psql > "$WORK/src.counts"
count_rows dst_psql > "$WORK/dst.counts"

if diff -u --label SOURCE --label TARGET "$WORK/src.counts" "$WORK/dst.counts"; then
  echo "OK: row counts match on all $(wc -l < "$WORK/src.counts" | tr -d ' ') tables."
  echo "Next: run 'npx prisma migrate status' with DATABASE_URL=<TARGET> (see MIGRATION.md)."
else
  echo "ERROR: row count mismatch between SOURCE and TARGET (diff above)." >&2
  exit 1
fi
