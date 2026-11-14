# Data migration to vm-data

Source: current Postgres (today the Supabase one, the existing `DATABASE_URL`).
Target: Postgres on vm-data, same major as the source. Only schema `public` is copied
(including `_prisma_migrations`).
Supabase internal schemas (`auth`, `storage`, `extensions`, ...) and roles (`anon`,
`authenticated`, `service_role`) are not copied: authentication stays in Supabase and users are
linked by email/UUID already present in `public`.

## Prerequisites

- **Match Postgres majors.** Source server, target server and client tools must all be the same
  major. Check the source with `psql "$SOURCE_URL" -Atc 'SHOW server_version'` (new Supabase
  projects run **17**). Then:
  - vm-data: set `POSTGRES_IMAGE_TAG` in `deploy/vm-data/.env` to that major (e.g. `17`)
    **before the first** `docker compose up -d`. If vm-data already started with another major,
    the data volume is incompatible: on vm-data only, `docker compose down -v` (deletes the
    target data) and `up -d` again.
  - client tools: `pg_dump`, `pg_restore` and `psql` of that major on PATH
    (`apt install postgresql-client-17` from the PGDG repo; put `/usr/lib/postgresql/17/bin` first
    on PATH if several versions are installed).

  Why: `pg_dump` refuses to dump a server newer than itself, and a dump made by a newer
  `pg_dump` contains settings an older server rejects (a 17 dump emits
  `SET transaction_timeout`, which errors on 16). The script checks all four versions first and
  aborts with guidance on any mismatch.
- vm-data is up (`deploy/vm-data/docker-compose.yml`) and the target database exists and is empty
  (`POSTGRES_DB`).
- A machine that can reach both databases.
- Supabase: use the direct connection string (port 5432), not the transaction pooler.

## Cutover

1. **Cutover window.** Stop writes: shut down the current backend.
2. **Dump + restore + verify.** Run:
   ```bash
   ./migrate-data.sh "$SOURCE_URL" "$TARGET_URL"
   ```
   The script (0) checks that source server, target server, `pg_dump`, `pg_restore` and `psql`
   share the same major, (1) lists objects in `public` that depend on Supabase-only schemas or
   roles and stops (exit 1) unless `--force` is passed, (2) runs
   `pg_dump -Fc --no-owner --no-acl -n public`, (3) runs `pg_restore --no-owner --no-acl`,
   (4) compares row counts per table and exits 1 on any mismatch. It also aborts if the target
   `public` schema already has tables. A failed restore is tolerated only if its sole error is
   `schema "public" already exists`; any other error line (including
   `pg_restore: error: connection to server ... failed`) stops the script unless `--force` is
   given. The source is only read (read-only session queries and `pg_dump`).
3. **Review Supabase-only dependencies.** Step (1) reports, and the restore gate will then trip
   on:
   - RLS policies / functions / views / defaults that use `auth.uid()` or other `auth.*`;
   - policies declared `TO authenticated` / `TO anon` / `TO service_role` (those roles do not
     exist on vm-data, so `CREATE POLICY` fails);
   - column defaults using `extensions.*` (e.g. `extensions.uuid_generate_v4()`): schema
     `extensions` does not exist on vm-data.

   Decide whether each is needed on vm-data (on the source, drop or rewrite it, or create the
   missing role / extension on the target beforehand). Re-run with `--force` only after deciding:
   objects that fail to restore are then simply missing on the target.
4. **Migration status.** Against the target:
   ```bash
   DATABASE_URL="$TARGET_URL" npx prisma migrate status
   ```
   Expected: "Database schema is up to date" - no pending or divergent migrations.
5. **Start the api** with the new `DATABASE_URL` in `deploy/vm-app/.env`. `prisma migrate deploy`
   runs on boot and applies nothing. Start the worker, then check `/health` on both.
6. **Rollback.** Point `DATABASE_URL` back to the source and restart the old backend. Nothing is
   deleted from the source at any point.

## Resetting a half-restored target

A failed or interrupted restore leaves the target non-empty, and the script then refuses to run
("TARGET schema public already has N table(s)"). Reset the **TARGET** (vm-data) only - never run
this against the source:

```bash
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
```

Then fix the cause and re-run `migrate-data.sh`.
