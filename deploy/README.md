# Deploy

Three VMs: **data**, **worker**, **app**. Each has its own compose file and `.env.example`.
Copy `.env.example` to `.env` on each VM and fill it in.

## Order

1. **vm-data** - `cd deploy/vm-data && cp .env.example .env`, set `POSTGRES_IMAGE_TAG` (default 16;
   if you will migrate existing data, the source Postgres major, e.g. 17), then `docker compose up -d`.
   On the first init (empty data volume) `./initdb/01-platform-schema.sql` is mounted into
   `/docker-entrypoint-initdb.d` and creates schema `platform` with the search_path set. It does not
   run again on an already initialised volume.
   Only if carrying over existing data: see [vm-data/MIGRATION.md](vm-data/MIGRATION.md).
   Backups: `backup.sh`, cron `0 3 * * * /opt/smartconcrete/deploy/vm-data/backup.sh`
   (daily `pg_dump -Fc` into `backups/`, keeps the 7 newest).
2. **vm-worker** - install Tailscale on the host first ([vm-worker/TAILSCALE.md](vm-worker/TAILSCALE.md)),
   then `cd deploy/vm-worker && cp .env.example .env && docker compose up -d --build`.
3. **vm-app** - `cd deploy/vm-app && cp .env.example .env && docker compose --env-file .env up -d --build`.
   The frontend is built from `../KronosFrontend` (sibling of this repo; it has its own Dockerfile).
   DNS for `APP_DOMAIN` and `API_DOMAIN` must point to this VM before first start (Caddy issues
   certificates automatically). Caddy proxies WebSocket (Socket.io) by default.
   The api runs `prisma migrate deploy` on start (creates the tables in schema `platform`).
   **First deploy only**, once the api is up, load the base data (roles, permissions, ...):
   ```bash
   docker compose exec api npm run seed
   ```
   The runtime image contains `tsx` and `prisma/seed.ts` (both needed by `seed`), so it runs
   inside the container. Do not re-run it blindly on a populated database.
   First-deploy order: vm-data, then api (migrations), then seed, then worker.

## Firewall

| VM | Inbound |
|----|---------|
| vm-data | 5432 and 6379 **only** from the private IPs of vm-app and vm-worker |
| vm-worker | no public ports. The worker uses `network_mode: host`, so `HEALTH_PORT` (3001) is bound on the host: block it from outside |
| vm-app | 80 and 443 public |

Postgres and Redis are published only on `PRIVATE_IP` of vm-data.

## Env vars per VM

| VM | Variable | Notes |
|----|----------|-------|
| data | `PRIVATE_IP`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `REDIS_PASSWORD` | URL-safe passwords recommended (see below) |
| data | `POSTGRES_IMAGE_TAG` (16) | Postgres major; set it to the migration source's major (e.g. 17) before first start |
| worker | `DATABASE_URL` | `postgresql://USER:PASS@<data-private-ip>:5432/DB?schema=platform` |
| worker | `REDIS_URL` | `redis://:PASSWORD@<data-private-ip>:6379` (password required) |
| worker | `HEALTH_PORT` (3001), `DEVICE_LOCK_WAIT_MS` (900000), `DEVICE_TEST_TIMEOUT_MS` (5000), `DEVICE_OP_TIMEOUT_MS` (10000) | |
| app | `DATABASE_URL`, `REDIS_URL` | same formats as worker |
| app | `PORT` (3000), `FRONTEND_URL`, `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `SCHEDULER_MAX_BACKLOG_SECONDS` (900), `DEVICE_TEST_TIMEOUT_MS` (5000), `DEVICE_OP_TIMEOUT_MS` (10000) | api-only |
| app | `LAAS_TITLE`, `LAAS_DESCRIPTION`, `LAAS_TERMS_URL`, `LAAS_CONTACT`, `LAAS_LICENSE`, `LAAS_LICENSE_URL`, `LAAS_BASE_URL` | IEEE 1876 service description (`/laas/v1`), optional |
| app | `APP_DOMAIN`, `API_DOMAIN` | Caddy |
| app | `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PUBLIC_URL` | frontend build args (baked at build time; rebuild to change) |

`REDIS_URL` is required by both apps; they refuse to boot without it.

**Passwords in URLs.** `POSTGRES_PASSWORD` / `REDIS_PASSWORD` end up inside `DATABASE_URL` /
`REDIS_URL`. If they contain `@ : / # ? % &` or similar, they must be percent-encoded there
(e.g. `p@ss` -> `p%40ss`), or the URL is parsed wrongly. Simplest: generate URL-safe passwords
with `openssl rand -hex 24`.

**Redeploys.** Compose gives the worker `stop_grace_period: 2m` and the api 30s, so an active
measurement / in-flight request can finish on SIGTERM before the container is killed.

## Scaling to N API replicas

Run more `api` services (e.g. `api1`, `api2`) with the same `.env` (Socket.io uses the Redis
adapter) and list them in the Caddyfile with cookie-based sticky sessions:

```
{$API_DOMAIN} {
	reverse_proxy api1:3000 api2:3000 {
		lb_policy cookie
	}
}
```
