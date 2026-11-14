#!/usr/bin/env bash
# Migrate the `public` schema from SOURCE to TARGET Postgres.
#
# Usage: migrate-data.sh SOURCE_URL TARGET_URL [--force]
#
# Requires pg_dump, pg_restore and psql on PATH with the SAME MAJOR version as the SOURCE
# server, and a TARGET server of that same major (vm-data: POSTGRES_IMAGE_TAG). This is checked
# first and the script aborts on any mismatch: pg_dump refuses a server newer than itself, and a
# newer dump emits settings an older server rejects (e.g. `SET transaction_timeout` from 17).
# (Chosen over `docker run postgres:N` wrappers so URLs with localhost / private IPs behave
# exactly like the host.) On Debian/Ubuntu: apt install postgresql-client-<major> (PGDG repo).
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
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin not found on PATH (need client tools matching the SOURCE major)" >&2; exit 2; }
done

# Every query against the source runs in a read-only session.
src_psql() { PGOPTIONS='-c default_transaction_read_only=on' psql "$SOURCE_URL" -X -v ON_ERROR_STOP=1 -At "$@"; }
dst_psql() { psql "$TARGET_URL" -X -v ON_ERROR_STOP=1 -At "$@"; }

# Prints the pg_restore stderr lines (file $1) that are NOT part of the known benign failure.
# Benign set: the `schema "public" already exists` error line, its `Command was:` line and
# `warning: errors ignored on restore: 1`. If the benign error line is missing, the summary
# line is reported too, so an unexplained non-zero exit never passes.
restore_unexpected_errors() {
  local benign='^pg_restore: error: could not execute query: ERROR:  schema "public" already exists$'
  local ignored='^pg_restore: warning: errors ignored on restore: 1$'
  local lines
  lines="$(tr -d '\r' < "$1" | grep -iE 'error' || true)"
  if grep -qE "$benign" <<< "$lines"; then
    grep -vE "$benign|$ignored" <<< "$lines" || true
  elif [ -n "$lines" ]; then
    printf '%s\n' "$lines"
  else
    echo "pg_restore failed without reporting an error line"
  fi
}

# First integer in a `<tool> --version` line, e.g. "pg_dump (PostgreSQL) 17.2 (Debian ...)" -> 17
tool_major() { "$1" --version | head -n 1 | sed -nE 's/^[^0-9]*([0-9]+).*/\1/p'; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- (0) Version compatibility ------------------------------------------------------------------
echo "==> [0/4] Checking Postgres versions (source server, client tools, target server)"
SRC_NUM="$(src_psql -c "SHOW server_version_num")"
TGT_NUM="$(dst_psql -c "SHOW server_version_num")"
SRC_MAJOR=$(( SRC_NUM / 10000 ))
TGT_MAJOR=$(( TGT_NUM / 10000 ))
DUMP_MAJOR="$(tool_major pg_dump)"
RESTORE_MAJOR="$(tool_major pg_restore)"
PSQL_MAJOR="$(tool_major psql)"
echo "    source server $SRC_MAJOR ($SRC_NUM), target server $TGT_MAJOR ($TGT_NUM)," \
     "pg_dump $DUMP_MAJOR, pg_restore $RESTORE_MAJOR, psql $PSQL_MAJOR"
VERSION_ERR=0
for pair in "pg_dump:$DUMP_MAJOR" "pg_restore:$RESTORE_MAJOR" "psql:$PSQL_MAJOR" "target server:$TGT_MAJOR"; do
  name="${pair%%:*}"; major="${pair##*:}"
  if [ -z "$major" ] || [ "$major" -ne "$SRC_MAJOR" ]; then
    echo "ERROR: $name major is '${major:-unknown}', but the SOURCE server is $SRC_MAJOR." >&2
    VERSION_ERR=1
  fi
done
if [ "$VERSION_ERR" -ne 0 ]; then
  cat >&2 <<EOF
All majors must match the SOURCE ($SRC_MAJOR). Fix, then re-run:
  - client tools: install postgresql-client-$SRC_MAJOR (PGDG repo) and put its bin dir first on PATH
    (e.g. PATH=/usr/lib/postgresql/$SRC_MAJOR/bin:\$PATH).
  - target server: set POSTGRES_IMAGE_TAG=$SRC_MAJOR in deploy/vm-data/.env. If vm-data already
    started with another major, its data volume is incompatible: on vm-data only,
    'docker compose down -v' (deletes the TARGET data) and 'docker compose up -d' again.
EOF
  exit 1
fi

# --- (1) Supabase-specific dependencies (schema auth, extensions, Supabase roles) -------------
echo "==> [1/4] Checking for objects that depend on Supabase-only schemas/roles in SOURCE"
WARN="$WORK/warnings.txt"
: > "$WARN"
src_psql -c "SELECT 'POLICY   ' || schemaname || '.' || tablename || ' :: ' || policyname
             FROM pg_policies
             WHERE schemaname = 'public'
               AND (coalesce(qual,'') ILIKE '%auth.%' OR coalesce(with_check,'') ILIKE '%auth.%')" >> "$WARN"
src_psql -c "SELECT 'FUNCTION ' || n.nspname || '.' || p.proname
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
               AND (p.prosrc ILIKE '%auth.%' OR coalesce(p.prosqlbody::text,'') ILIKE '%auth.%')" >> "$WARN"
src_psql -c "SELECT 'DEFAULT  ' || c.relname || '.' || a.attname
             FROM pg_attrdef d
             JOIN pg_class c ON c.oid = d.adrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
             WHERE n.nspname = 'public' AND pg_get_expr(d.adbin, d.adrelid) ILIKE '%auth.%'" >> "$WARN"
src_psql -c "SELECT 'VIEW     ' || schemaname || '.' || viewname
             FROM pg_views
             WHERE schemaname = 'public' AND definition ILIKE '%auth.%'" >> "$WARN"
# Also Supabase-only: roles anon/authenticated/service_role and schema `extensions` do not exist
# on vm-data, so these objects would make pg_restore fail (and trip the restore gate below).
src_psql -c "SELECT 'POLICY   ' || schemaname || '.' || tablename || ' :: ' || policyname
                    || ' TO ' || array_to_string(roles, ',')
             FROM pg_policies
             WHERE schemaname = 'public'
               AND roles && ARRAY['anon','authenticated','service_role']::name[]" >> "$WARN"
src_psql -c "SELECT 'DEFAULT  ' || c.relname || '.' || a.attname || ' uses schema extensions'
             FROM pg_attrdef d
             JOIN pg_class c ON c.oid = d.adrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
             WHERE n.nspname = 'public' AND pg_get_expr(d.adbin, d.adrelid) ILIKE '%extensions.%'" >> "$WARN"

if [ -s "$WARN" ]; then
  echo "WARNING: the following objects depend on Supabase-only schemas/roles (auth, extensions," >&2
  echo "anon/authenticated/service_role) that are NOT migrated; pg_restore will likely fail on them:" >&2
  sed 's/^/  - /' "$WARN" >&2
  if [ "$FORCE" -ne 1 ]; then
    echo "Stopping. Review them, then re-run with --force to continue." >&2
    exit 1
  fi
  echo "--force given: continuing despite warnings." >&2
else
  echo "    none found"
fi

# --- (1b) Target must have no tables in public --------------------------------------------
TGT_TABLES="$(dst_psql -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
if [ "$TGT_TABLES" -ne 0 ]; then
  echo "ERROR: TARGET schema public already has $TGT_TABLES table(s); it must be empty. Aborting." >&2
  exit 1
fi

# --- (2) Dump ---------------------------------------------------------------------------------
DUMP="$WORK/public.dump"
echo "==> [2/4] pg_dump -Fc (schema public) from SOURCE"
pg_dump -Fc --no-owner --no-acl -n public -f "$DUMP" "$SOURCE_URL"

# --- (3) Restore ------------------------------------------------------------------------------
echo "==> [3/4] pg_restore into TARGET"
RESTORE_ERR="$WORK/restore.err"
set +e
pg_restore --no-owner --no-acl -d "$TARGET_URL" "$DUMP" 2> "$RESTORE_ERR"
RC=$?
set -e
cat "$RESTORE_ERR" >&2
if [ "$RC" -ne 0 ]; then
  # Benign ONLY if every line mentioning "error" (any case) belongs to the known failure
  # `schema "public" already exists` and the restore reports exactly 1 ignored error.
  # Anything else (incl. "pg_restore: error: connection to server ... failed") is unexpected.
  UNEXPECTED="$(restore_unexpected_errors "$RESTORE_ERR")"
  if [ -n "$UNEXPECTED" ]; then
    echo "ERROR: pg_restore reported unexpected errors:" >&2
    echo "$UNEXPECTED" | sed 's/^/  /' >&2
    if [ "$FORCE" -ne 1 ]; then
      echo "Stopping (schema may be incomplete: constraints, indexes, FKs, defaults). Use --force to continue anyway." >&2
      echo "The TARGET is now partially restored; reset it before re-running (see MIGRATION.md)." >&2
      exit 1
    fi
    echo "--force given: continuing despite restore errors." >&2
  else
    echo "NOTE: pg_restore exited $RC only because schema \"public\" already exists (benign)." >&2
  fi
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
if [ ! -s "$WORK/src.counts" ]; then
  echo "ERROR: SOURCE has no tables in public; nothing to verify." >&2
  exit 1
fi

if diff -u --label SOURCE --label TARGET "$WORK/src.counts" "$WORK/dst.counts"; then
  echo "OK: row counts match on all $(wc -l < "$WORK/src.counts" | tr -d ' ') tables."
  echo "Next: run 'npx prisma migrate status' with DATABASE_URL=<TARGET> (see MIGRATION.md)."
else
  echo "ERROR: row count mismatch between SOURCE and TARGET (diff above)." >&2
  exit 1
fi
