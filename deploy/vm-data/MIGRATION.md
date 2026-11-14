# Data migration to vm-data

Source: current Postgres (today the Supabase one, the existing `DATABASE_URL`).
Target: Postgres 16 on vm-data. Only schema `public` is copied (including `_prisma_migrations`).
Supabase internal schemas (`auth`, `storage`, ...) are not copied: authentication stays in
Supabase and users are linked by email/UUID already present in `public`.

## Prerequisites

- vm-data is up (`deploy/vm-data/docker-compose.yml`) and the target database exists and is empty
  (`POSTGRES_DB`).
- A machine that can reach both databases, with `pg_dump`, `pg_restore` and `psql` **v16** on PATH
  (`apt install postgresql-client-16`).
- Supabase: use the direct connection string (port 5432), not the transaction pooler.

## Cutover

1. **Cutover window.** Stop writes: shut down the current backend.
2. **Dump + restore + verify.** Run:
   ```bash
   ./migrate-data.sh "$SOURCE_URL" "$TARGET_URL"
   ```
   The script (a) lists policies, functions and views in `public` that reference schema `auth`
   and stops (exit 1) unless `--force` is passed, (b) runs
   `pg_dump -Fc --no-owner --no-acl -n public`, (c) runs `pg_restore --no-owner --no-acl`,
   (d) compares row counts per table and exits 1 on any mismatch. It also aborts if the target
   `public` schema already has tables, and fails on any `pg_restore` error other than
   `schema "public" already exists` unless `--force` is given. The source is only read
   (read-only session queries and `pg_dump`).
3. **Review `auth` warnings.** If the script warned about RLS policies / functions using
   `auth.uid()`, decide whether they are needed on vm-data (they would fail there, since the
   `auth` schema does not exist). Re-run with `--force` only after deciding.
4. **Migration status.** Against the target:
   ```bash
   DATABASE_URL="$TARGET_URL" npx prisma migrate status
   ```
   Expected: "Database schema is up to date" - no pending or divergent migrations.
5. **Start the api** with the new `DATABASE_URL` in `deploy/vm-app/.env`. `prisma migrate deploy`
   runs on boot and applies nothing. Start the worker, then check `/health` on both.
6. **Rollback.** Point `DATABASE_URL` back to the source and restart the old backend. Nothing is
   deleted from the source at any point.
