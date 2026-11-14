# Monorepo API + Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split SmartConcreteBackend into a Nest CLI monorepo with `apps/api` (public, no lab access) and `apps/worker` (cron, measurements, device health, device ops), sharing `libs/*`, plus Docker/compose files for 3 VMs and a data-migration runbook.

**Architecture:** Nest monorepo (`"monorepo": true`, webpack builds). Domain code moves to libs imported as `@app/<lib>`. Both apps talk only through Redis: Bull queues (`measurements`, `device-ops`) and Socket.io events published with `@socket.io/redis-emitter` and delivered by `@socket.io/redis-adapter` in the API. Redis locks give device exclusivity and leader election for cron/interval tasks.

**Tech Stack:** NestJS 11, Prisma 7 (`@prisma/adapter-pg`), Bull 4 (`@nestjs/bull`), ioredis 5, Socket.io 4, `@socket.io/redis-adapter@8`, `@socket.io/redis-emitter@5`, Jest 30, Node 24, Docker, Caddy 2, Postgres 16, Redis 7.

**Spec:** `docs/superpowers/specs/2026-11-13-monorepo-api-worker-design.md`

## Global Constraints

- HTTP routes, Socket.io namespaces (`/kronos`, `/measurements`), event names, room names (`user:<id>`, `task:<id>`, raw `<userId>` in `/measurements`) and payload shapes stay byte-for-byte identical. KronosFrontend source is not modified (only a `Dockerfile` + `nginx.conf` are added there).
- Database schema and `prisma/` migrations unchanged.
- Supabase Auth stays (`SupabaseStrategy`, `CombinedAuthGuard` untouched in behavior).
- `REDIS_URL` is required by both apps; boot fails with `Error('REDIS_URL is required')` if missing. The no-Redis direct-execution fallback is removed.
- Only `apps/worker` may import `@app/device-plugins` runtime calls that open sockets (`testConnection`, `selectChannel`, `measureChannel`). `apps/api` must not.
- Measurement processor concurrency stays 1 per worker.
- Defaults: api `PORT=3000`; worker `HEALTH_PORT=3001`; `DEVICE_TEST_TIMEOUT_MS=5000`; device lock TTL 60 000 ms renewed every 20 000 ms; device lock wait cap `DEVICE_LOCK_WAIT_MS=900000`; leader TTL scheduler 55 000 ms, device-health 25 000 ms (not released at end of tick).
- Work on branch `feat/monorepo-api-worker`; never push.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Redis unreachable while a user clicks "test connection" → API answers the normal `{success:false, message}` within ~timeout, never a 500. (Test in Task 8.)
- Worker process dies mid-measurement → device lock expires by TTL and the next job on that MUX runs. (Test in Task 6.)
- Two API replicas: an event published by the worker reaches a socket connected to either replica. (Test in Task 3.)
- `device-ops` jobs with no worker online don't pile up in Redis after timing out. (Test in Task 8.)
- Source DB has RLS policies/functions referencing `auth.*` → migration script warns before restore. (Check in Task 10.)

## File Structure

```
nest-cli.json                         monorepo config (projects: api, worker, libs)
tsconfig.json                         + paths "@app/<lib>" → libs/<lib>/src
package.json                          scripts, jest moduleNameMapper, new deps
apps/api/src/                         (current src/ moved here, minus what goes to libs/worker)
apps/api/tsconfig.app.json
apps/worker/src/main.ts               health-only HTTP on HEALTH_PORT
apps/worker/src/worker.module.ts
apps/worker/src/health.controller.ts
apps/worker/src/scheduler/scheduler.service.ts      (moved from src/scheduler, leader-locked)
apps/worker/src/processors/measurement.processor.ts (moved, device-locked)
apps/worker/src/processors/device-ops.processor.ts  (new)
apps/worker/src/devices/device-health.service.ts    (moved, leader-locked)
apps/worker/tsconfig.app.json
libs/database/src/   PrismaModule, PrismaService
libs/redis/src/      RedisModule (REDIS_CLIENT), RedisLockService
libs/queue/src/      QueueModule, queue names, job payload types
libs/realtime/src/   RealtimePublisher, RealtimeModule, payload types
libs/device-plugins/src/  registry + hioki plugin (moved)
libs/common/src/     TeamScopeService, decorators, validators (moved)
libs/notifications/src/   NotificationWriter (write + publish)
libs/measurement/src/     MeasurementExecutor, kronos-watcher, estimateSeconds
docker-compose.dev.yml
Dockerfile                            targets: api, worker
deploy/vm-app/{docker-compose.yml,Caddyfile,.env.example}
deploy/vm-worker/{docker-compose.yml,.env.example,TAILSCALE.md}
deploy/vm-data/{docker-compose.yml,.env.example,backup.sh,migrate-data.sh,MIGRATION.md}
deploy/README.md
../KronosFrontend/{Dockerfile,nginx.conf}
```

---

### Task 0: Environment and baseline

**Files:** none.

- [ ] **Step 1:** Ensure Node 24 is available (`winget install OpenJS.NodeJS.LTS` if `node -v` fails) and Docker Desktop is running (`docker version` shows a Server).
- [ ] **Step 2:** `git switch -c feat/monorepo-api-worker`; ensure `git config user.name`/`user.email` are set (ask the user if not).
- [ ] **Step 3:** `npm ci && npx prisma generate && npm run build && npx jest` → build succeeds; record which existing specs pass (baseline). Any pre-existing failure is noted, not fixed.

### Task 1: Monorepo scaffold (no behavior change)

**Files:**
- Move: `src/**` → `apps/api/src/**` (`git mv`); `test/` → `apps/api/test/`
- Create: `apps/api/tsconfig.app.json`, `apps/worker/tsconfig.app.json` (placeholder app built in Task 7)
- Modify: `nest-cli.json`, `tsconfig.json`, `tsconfig.build.json`, `package.json`

**Interfaces:**
- Produces: `npm run build:api` → `dist/apps/api/main.js`; jest resolves `^@app/(.*)$` → `<rootDir>/libs/$1/src`; jest `roots: ["<rootDir>/apps", "<rootDir>/libs"]`.

- [ ] **Step 1:** Set `nest-cli.json` to `{ "monorepo": true, "root": "apps/api", "sourceRoot": "apps/api/src", "compilerOptions": { "webpack": true, "tsConfigPath": "apps/api/tsconfig.app.json", "deleteOutDir": true }, "projects": { "api": {type application, root apps/api, entryFile main, sourceRoot apps/api/src, tsConfigPath apps/api/tsconfig.app.json}, "worker": {same shape, apps/worker} } }`. Libs are added to `projects` as they are created (`type: library`, `root: libs/<x>`, `sourceRoot: libs/<x>/src`).
- [ ] **Step 2:** Scripts: `build` = `nest build api && nest build worker`, `build:api`, `build:worker`, `start:api` = `node dist/apps/api/main`, `start:worker` = `node dist/apps/worker/main`. Keep `seed`. Remove `start:prod` (replaced).
- [ ] **Step 3:** Fix relative imports broken by the move only if any reference outside `src/` (e.g. `prisma.config.ts` is at root — unchanged).
- [ ] **Step 4:** Run `npm run build:api && npx jest` → same results as baseline.
- [ ] **Step 5:** Commit `refactor: convert backend to nest monorepo (apps/api)`.

### Task 2: Extract shared libs: database, redis, common, device-plugins

**Files:**
- Move: `apps/api/src/prisma/{prisma.module,prisma.service}.ts` → `libs/database/src/`; `apps/api/src/redis/redis.module.ts` → `libs/redis/src/`; `apps/api/src/common/**` → `libs/common/src/`; `apps/api/src/device-plugins/**` → `libs/device-plugins/src/`. `prisma.middleware.ts` (RLS) stays in api.
- Create: `libs/<each>/src/index.ts` barrel; `libs/<each>/tsconfig.lib.json`.
- Modify: every importer → `@app/database`, `@app/redis`, `@app/common`, `@app/device-plugins`.

**Interfaces:**
- Produces: `PrismaModule`, `PrismaService` from `@app/database`; `RedisModule`, `REDIS_CLIENT` from `@app/redis`; `CommonModule`, `TeamScopeService`, decorators/validators from `@app/common`; `DevicePluginsModule`, `DevicePluginRegistry`, `DeviceDriverPlugin` types from `@app/device-plugins`.

- [ ] **Step 1:** `RedisModule` factory now throws `new Error('REDIS_URL is required')` when `REDIS_URL` is empty (provider no longer returns `null`). Write `libs/redis/src/redis.module.spec.ts`: `it('fails fast without REDIS_URL')` → compiling a testing module with `RedisModule` and `delete process.env.REDIS_URL` rejects with `/REDIS_URL is required/`.
- [ ] **Step 2:** Run it → FAIL (currently returns null).
- [ ] **Step 3:** Move files, add tsconfig paths and nest-cli lib projects, update imports, apply the fail-fast change. Remove `@Optional()` null-handling for `REDIS_CLIENT` in consumers (health check, permission cache) — Redis is always present.
- [ ] **Step 4:** `npm run build:api && npx jest` → green.
- [ ] **Step 5:** Commit `refactor: extract database, redis, common and device-plugins libs`.

### Task 3: libs/realtime — publish events through Redis

**Files:**
- Create: `libs/realtime/src/{realtime.publisher.ts,realtime.module.ts,payloads.ts,index.ts}`, `libs/realtime/src/realtime.publisher.spec.ts`
- Modify: `apps/api/src/gateway/kronos.gateway.ts`, `apps/api/src/measurements/measurements.gateway.ts` (remove all `emit*` methods; keep `join`/`join-task`/`leave-task` handlers and connection logs), `apps/api/src/main.ts` (Redis adapter), every `emit*` call site → `RealtimePublisher`.
- Add deps: `@socket.io/redis-emitter@^5`, `@socket.io/redis-adapter@^8`; devDep `ioredis-mock`.

**Interfaces:**
- Consumes: `REDIS_CLIENT` (ioredis) from `@app/redis`.
- Produces (`@app/realtime`), class `RealtimePublisher` (injectable, uses `new Emitter(redis)` and `.of('/kronos')` / `.of('/measurements')`):
  - `measurementComplete(taskId: number, data: Record<string, unknown>): void` → `/kronos` room `task:${taskId}` event `measurement:complete` payload `{ taskId, ...data }`
  - `jobStatus(userId: string, status: JobStatusPayload): void` → `/kronos` room `user:${userId}` event `job:status`
  - `notification(userId: string, n: NotificationPayload): void` → `/kronos` room `user:${userId}` event `notification`
  - `deviceStatus(deviceId: string, projectId: string, status: string): void` → `/kronos` broadcast `device:status` `{ deviceId, projectId, status }`
  - `measurementProgress(userId: string, jobId: string, channel: number, total: number, percent: number, message: string): void` → `/measurements` room `userId` event `measurement:progress` `{ jobId, channel, total, percent, status: 'measuring', message }`
  - `measurementCompleted(userId: string, jobId: string, measurementId: number, takenAt: Date, totalPoints: number, data: unknown): void` → `measurement:completed` `{ jobId, measurementId, takenAt, totalPoints, data }`
  - `measurementError(userId: string, jobId: string, message: string): void` → `measurement:error` `{ jobId, message }`
  - `JobStatusPayload` moves here from `kronos.gateway.ts` unchanged.
- Produces: `RealtimeModule` (imports `RedisModule`, exports `RealtimePublisher`).

- [ ] **Step 1:** Write `realtime.publisher.spec.ts`, mocking `@socket.io/redis-emitter` (`jest.mock`) so `of(ns).to(room).emit(evt, payload)` is recorded. One test per method asserting namespace, room, event and payload exactly as listed above, e.g.:

```ts
it('measurementProgress keeps the legacy payload', () => {
  publisher.measurementProgress('u1', 'j1', 2, 4, 50, 'msg');
  expect(calls).toContainEqual({ ns: '/measurements', room: 'u1', event: 'measurement:progress',
    payload: { jobId: 'j1', channel: 2, total: 4, percent: 50, status: 'measuring', message: 'msg' } });
});
```

- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement publisher/module; replace call sites (`measurements.service`, `scheduling.service`, `scheduler.service`, `measurement.processor`, `device-health.service`, `notifications.service`); delete gateway `emit*` methods.
- [ ] **Step 4:** In `apps/api/src/main.ts`, before `listen`, attach a `RedisIoAdapter extends IoAdapter` (file `apps/api/src/realtime/redis-io.adapter.ts`) whose `createIOServer` calls `server.adapter(createAdapter(pub, sub))` with `pub = new Redis(REDIS_URL)`, `sub = pub.duplicate()`.
- [ ] **Step 5:** Add integration test `apps/api/test/realtime.e2e-spec.ts` (runs only when `REDIS_URL` is set, `describe.skip` otherwise): start two Socket.io servers on random ports with `RedisIoAdapter`, connect a client to server B in `/kronos`, join `user:u1`, call `RealtimePublisher.jobStatus('u1', {...})` → client receives `job:status` within 2 s.
- [ ] **Step 6:** `npx jest` green; with `docker compose -f docker-compose.dev.yml up -d redis` and `REDIS_URL=redis://localhost:6379 npx jest --config apps/api/test/jest-e2e.json realtime` → PASS. (Create `docker-compose.dev.yml` with `redis:7-alpine` on 6379 here.)
- [ ] **Step 7:** Commit `feat: publish realtime events via redis emitter and adapter`.

### Task 4: libs/notifications — write + publish

**Files:**
- Create: `libs/notifications/src/{notification.writer.ts,notifications.module.ts,index.ts}`, `notification.writer.spec.ts`
- Modify: `apps/api/src/notifications/notifications.service.ts` (keeps reads: `findRecentActivityForTeam`, `findForUser`, `countUnread`, `markAsRead`, `markAllAsRead`; `notifyMember*`/`notifyAdminNewRequest` delegate to writer), `apps/api/src/teams/teams.service.ts` unchanged API.

**Interfaces:**
- Consumes: `PrismaService`, `RealtimePublisher`.
- Produces (`@app/notifications`) `NotificationWriter` with the existing method signatures moved verbatim: `notifyMemberApproved(userId, teamId, teamName)`, `notifyMemberRejected(userId, teamId, teamName, attemptsLeft)`, `notifyAdminNewRequest(adminId, teamId, userName, teamName)`, `notifyTeamMeasurementSuccess(teamId, projectName, deviceNames)`, `notifyTeamMeasurementWarning(teamId, projectName, deviceNames, reason)`, `notifyTeamMeasurementFailed(teamId, projectName, deviceNames, errorMessage, bare = false)`; private `logEvent` moves too. `NotificationsModule` exports `NotificationWriter`.

- [ ] **Step 1:** Spec with mocked Prisma + publisher: `notifyTeamMeasurementFailed('t1','P',['MUX'],'boom')` creates one `activityEvent` with `type: 'MEASUREMENT_FAILED'`, `message: 'Ocurrió un error al medir en "P": boom\nMUX'`, recipients for each APPROVED member, and calls `publisher.notification` once per member with `{ id, type, title, message, read: false, createdAt }`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Move code; wire api service to delegate.
- [ ] **Step 4:** `npx jest` green; `npm run build:api` ok.
- [ ] **Step 5:** Commit `refactor: extract notification writer lib`.

### Task 5: libs/queue + libs/measurement; API admission without fallback

**Files:**
- Move: `apps/api/src/queue/*` → `libs/queue/src/`; `MeasurementJobData` type from `scheduling.service.ts` → `libs/queue/src/jobs.ts`; `apps/api/src/measurements/kronos-watcher.ts` → `libs/measurement/src/`.
- Create: `libs/measurement/src/{measurement.executor.ts,measurement.module.ts,estimate.ts,index.ts}`, `estimate.spec.ts`, `measurement.executor.spec.ts`
- Modify: `apps/api/src/measurements/measurements.service.ts` (remove `measureTask`, `notifyTeamOfMeasurementOutcome`, plugin + gateway deps), `apps/api/src/scheduler/scheduling.service.ts` (remove `fallbackRuns`, `trackFallbackRun`, `untrackFallbackRun`, direct-execution branch; queue is non-optional), `apps/api/src/scheduler/scheduler.module.ts` (drop `ScheduleModule.forRoot()`, `SchedulerService`, `MeasurementProcessor`).

**Interfaces:**
- Produces (`@app/queue`): `MEASUREMENTS_QUEUE = 'measurements'`, `DEVICE_OPS_QUEUE = 'device-ops'`, `QueueModule` (`BullModule.forRoot({ url: REDIS_URL })` + `registerQueue` for both; throws `'REDIS_URL is required'` if missing), `MeasurementJobData` (unchanged fields + `estimatedSeconds`), `TestConnectionJobData { type: string; ip: string; port: number }`.
- Produces (`@app/measurement`): `estimateSeconds(ranges: { points: number }[], channelCount: number): number` (constants moved from `scheduling.service.ts`), `classifyMeasurement` (moved), `MeasurementExecutor.measureTask(taskId: number, userId: string, params: { ranges; selectedChannels: number[]; jobId?: string; scheduledJobId?: number; executionIndex?: number })` with the current body, using `RealtimePublisher` and `NotificationWriter`. `MeasurementModule` exports `MeasurementExecutor`.

- [ ] **Step 1:** `estimate.spec.ts`: values computed with the current constants for (a) one range of 10 points, 1 channel, (b) two ranges, 3 channels — assert equality with the numbers produced by the old `scheduling.service` formula (compute them once from the constants before moving).
- [ ] **Step 2:** `measurement.executor.spec.ts`: with a fake plugin returning two points for channel 1, `measureTask(1,'u1',{ranges:[{...}],selectedChannels:[1],jobId:'j'})` calls `publisher.measurementProgress` at least once with jobId `'j'`, persists one `measurement`, calls `publisher.measurementCompleted('u1','j', <id>, ...)` and `publisher.measurementComplete(1, ...)`; with empty `selectedChannels` it calls `publisher.measurementError('u1','j', ...)` and rethrows as today.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Move/implement; trim api services as listed.
- [ ] **Step 5:** `npm run build:api && npx jest` green; `grep -rn "measureChannel\|selectChannel\|testConnection(" apps/api/src` only shows the devices controller/service (fixed in Task 8).
- [ ] **Step 6:** Commit `refactor: move measurement execution and queues to libs`.

### Task 6: RedisLockService (device locks + leader)

**Files:**
- Create: `libs/redis/src/redis-lock.service.ts`, `redis-lock.service.spec.ts` (uses `ioredis-mock`)
- Modify: `libs/redis/src/redis.module.ts` (provide/export `RedisLockService`)

**Interfaces:**
- Produces (`@app/redis`):
  - `tryAcquire(key: string, ttlMs: number): Promise<string | null>` — `SET key token PX ttl NX`, returns token.
  - `renew(key: string, token: string, ttlMs: number): Promise<boolean>` — Lua compare-and-`PEXPIRE`.
  - `release(key: string, token: string): Promise<void>` — Lua compare-and-`DEL`.
  - `runAsLeader(name: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean>` — key `lock:leader:${name}`; runs `fn` only if acquired; **does not release** (TTL expiry ends leadership for that tick); returns whether it ran.
  - `withDeviceLocks<T>(deviceIds: string[], fn: () => Promise<T>, opts?: { ttlMs?: number; renewEveryMs?: number; waitTimeoutMs?: number; pollMs?: number }): Promise<T>` — keys `lock:device:<id>` acquired in sorted id order; if any is held, release the ones taken and retry with backoff from `pollMs` (default 2000) up to 10 000 ms; renew all every `renewEveryMs` while `fn` runs; release all in `finally`; throws `DeviceBusyTimeoutError` (exported) after `waitTimeoutMs` (default `DEVICE_LOCK_WAIT_MS` or 900 000).

- [ ] **Step 1:** Tests:
  - `runAsLeader` twice with same name within TTL → first returns `true`, second `false`, `fn` called once.
  - `withDeviceLocks(['m1','a1'])` while another call holds `m1` → second call's `fn` starts only after the first resolves (use deferred promises; assert order).
  - Holder never releases (simulate crash: `tryAcquire('lock:device:m1', 100)` and drop token) → `withDeviceLocks(['m1'], fn, {pollMs: 20})` runs `fn` after ~100 ms.
  - Wait cap: holder keeps lock, `waitTimeoutMs: 50` → rejects with `DeviceBusyTimeoutError`.
  - `release` with wrong token does not delete the key.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx jest libs/redis` → PASS.
- [ ] **Step 5:** Commit `feat: add redis lock service for device exclusivity and leader election`.

### Task 7: apps/worker

**Files:**
- Create: `apps/worker/src/{main.ts,worker.module.ts,health.controller.ts}`, `apps/worker/src/processors/device-ops.processor.ts`, specs `apps/worker/src/worker.module.spec.ts`, `processors/device-ops.processor.spec.ts`, `processors/measurement.processor.spec.ts`
- Move: `apps/api/src/scheduler/scheduler.service.ts` → `apps/worker/src/scheduler/`; `apps/api/src/scheduler/measurement.processor.ts` → `apps/worker/src/processors/`; `apps/api/src/devices/device-health.service.ts` → `apps/worker/src/devices/` (uses `DevicePluginRegistry` directly for reachability; `checkReachable(type, ip, port=3570)` moves into this service).

**Interfaces:**
- Consumes: `PrismaModule`, `RedisModule`/`RedisLockService`, `QueueModule`, `RealtimeModule`, `NotificationsModule`, `MeasurementModule`, `DevicePluginsModule`.
- Produces: `WorkerModule` = `ConfigModule.forRoot({isGlobal:true})`, `ScheduleModule.forRoot()`, the modules above; providers `SchedulerService`, `MeasurementProcessor`, `DeviceHealthService`, `DeviceOpsProcessor`; controller `HealthController` (`GET /health` → `{ status, timestamp, services: { database, redis } }`, same shape as api). `main.ts`: `NestFactory.create(WorkerModule)`, `enableShutdownHooks()`, `listen(Number(process.env.HEALTH_PORT ?? 3001))`, no CORS, no WebSocket adapter.
- `DeviceOpsProcessor` `@Processor(DEVICE_OPS_QUEUE)`, `@Process({ name: 'test-connection', concurrency: 5 }) handle(job: Job<TestConnectionJobData>): Promise<boolean>` → `registry.has(type) ? registry.get(type).testConnection(ip, type, port) : false`.
- `SchedulerService.processPendingJobs` body wrapped in `lockService.runAsLeader('scheduler', 55_000, ...)`; direct-execution fallback removed. `DeviceHealthService.checkAllDevices` wrapped in `runAsLeader('device-health', 25_000, ...)`.
- `MeasurementProcessor.handleExecute` wraps `executor.measureTask` in `lockService.withDeviceLocks([muxDeviceId, analyzerDeviceId], ...)`, ids read from the task's `TaskPreference` (`analyzerDeviceId`, `muxDeviceId`); if no preference, call `measureTask` without locks (it fails with its own error as today). `job:status` events unchanged.

- [ ] **Step 1:** `worker.module.spec.ts`: compile `WorkerModule` with Prisma/Redis/Bull providers overridden by mocks → module contains `SchedulerService`, `MeasurementProcessor`, `DeviceHealthService`, `DeviceOpsProcessor`; `app.get(KronosGateway)` is not resolvable (import from api must not exist — assert via `expect(() => moduleRef.get('KronosGateway', {strict:false})).toThrow()`); discovered controllers = `[HealthController]` only.
- [ ] **Step 2:** `device-ops.processor.spec.ts`: known type → delegates to plugin and returns its boolean; unknown type → `false` without calling any plugin.
- [ ] **Step 3:** `measurement.processor.spec.ts`: calls `withDeviceLocks(['mux1','an1'], …)` with ids from the preference; emits `job:status` `processing` then `completed` with the same `jobId: String(job.id)`.
- [ ] **Step 4:** Run → FAIL.
- [ ] **Step 5:** Implement; add `worker` (+ libs) to nest-cli projects.
- [ ] **Step 6:** `npm run build && npx jest` green; `node dist/apps/worker/main` with dev Redis + DB logs `Nest application successfully started` and `curl localhost:3001/health` → `status: ok`.
- [ ] **Step 7:** Commit `feat: add worker app with leader-locked scheduler and device-locked processor`.

### Task 8: API — no lab access, test-connection via worker, hardening

**Files:**
- Modify: `apps/api/src/devices/devices.service.ts` (`testConnection` enqueues; delete `checkReachable`; drop `DevicePluginRegistry` dep), `apps/api/src/devices/devices.module.ts` (drop `DeviceHealthService`; import `QueueModule`), `apps/api/src/app.module.ts` (drop `DevicePluginsModule` if unused), `apps/api/src/main.ts`
- Test: `apps/api/src/devices/devices.service.spec.ts`, `apps/api/src/app.module.spec.ts`

**Interfaces:**
- Consumes: `DEVICE_OPS_QUEUE`, `TestConnectionJobData`.
- Produces: `DevicesService.testConnection(dto: TestConnectionDto): Promise<{ success: boolean; message: string }>` — same messages as today (`Hioki IM3570 encontrado en ${ip}:${port}` / `MUX encontrado en ${ip}` / `No se pudo conectar al analyzer en ${ip}:${port}` / `No se pudo conectar al MUX en ${ip}`). Implementation: `queue.add('test-connection', {type, ip, port}, { attempts: 1, removeOnComplete: true, removeOnFail: true })`, then `Promise.race([job.finished(), timeout(DEVICE_TEST_TIMEOUT_MS)])`; on timeout or any error (including `add` failing because Redis is down) → log warning, best-effort `job.remove()`, return the "No se pudo conectar…" message.

- [ ] **Step 1:** `devices.service.spec.ts` with a fake queue:
  - job resolves `true` for analyzer `10.0.0.5:3570` → `{ success: true, message: 'Hioki IM3570 encontrado en 10.0.0.5:3570' }`.
  - job never resolves, timeout 50 ms → `{ success: false, message: 'No se pudo conectar al MUX en 10.0.0.6' }` and `job.remove` called.
  - `queue.add` rejects (Redis down) → same failure shape, no throw.
- [ ] **Step 2:** `app.module.spec.ts`: compiled api module (infra mocked) has no `SchedulerService`, `MeasurementProcessor`, `DeviceHealthService`, `DeviceOpsProcessor`, `MeasurementExecutor` providers; `grep`-style assertion in the test that `DevicePluginRegistry` is not resolvable.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement. `main.ts`: `app.set('trust proxy', 1)` (via `NestExpressApplication`), `enableCors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:5173', credentials: true, exposedHeaders: ['Content-Disposition'] })`, `listen(Number(process.env.PORT ?? 3000))`, `enableShutdownHooks()`.
- [ ] **Step 5:** `npm run build && npx jest` green.
- [ ] **Step 6:** Commit `feat: api delegates device connection tests to worker`.

### Task 9: Local development workflow

**Files:**
- Modify: `package.json` (`start:dev` = `concurrently -n api,worker "nest start api --watch" "nest start worker --watch"`; devDep `concurrently`), `docker-compose.dev.yml` (add optional `postgres:16-alpine` service under profile `db`), `README.md` (dev section: `docker compose -f docker-compose.dev.yml up -d`, `.env` needs `REDIS_URL`).
- Create: `.env.example` at repo root listing every variable from spec §7.7 with dev defaults.

- [ ] **Step 1:** `npm run start:dev` with dev Redis → both processes start; `GET :3000/health` and `GET :3001/health` return `ok`.
- [ ] **Step 2:** Commit `chore: dev workflow for api + worker`.

### Task 10: Docker images, per-VM deploy, data migration

**Files:** `Dockerfile`, `.dockerignore`, everything under `deploy/` (see File Structure), `../KronosFrontend/Dockerfile`, `../KronosFrontend/nginx.conf`.

**Decisions to encode:**
- `Dockerfile`: stage `build` (`node:24-bookworm-slim`, `apt openssl python3 make g++`, `npm ci`, `npx prisma generate`, `npm run build`, `npm prune --omit=dev`); stage `runtime-base` (`openssl ca-certificates wget`, copy `node_modules`, `dist`, `prisma`, `prisma.config.ts`, `package.json`, `USER node`); target `api` (`EXPOSE 3000`, healthcheck `wget -qO- localhost:3000/health`, `CMD sh -c "npx prisma migrate deploy && node dist/apps/api/main"`); target `worker` (`EXPOSE 3001`, healthcheck on 3001, `CMD node dist/apps/worker/main`).
- `deploy/vm-app/docker-compose.yml`: `api` (build target api, `env_file .env`, `restart: always`), `frontend` (build `../../../KronosFrontend` with `VITE_*` build args), `caddy:2-alpine` on 80/443 with `caddy_data` volume. `Caddyfile`: `{$APP_DOMAIN} { reverse_proxy frontend:80 }`, `{$API_DOMAIN} { reverse_proxy api:3000 }`.
- `deploy/vm-worker/docker-compose.yml`: `worker` (target worker, `network_mode: host` so Tailscale routes on the host reach the labs), `restart: always`. `TAILSCALE.md`: install, `tailscale up --accept-routes`, subnet router per lab.
- `deploy/vm-data/docker-compose.yml`: `postgres:16` (volume, `POSTGRES_*` from env, port bound to `${PRIVATE_IP}:5432`), `redis:7-alpine` (`--appendonly yes --requirepass ${REDIS_PASSWORD}`, volume, `${PRIVATE_IP}:6379`). `backup.sh`: `docker compose exec -T postgres pg_dump -Fc` to `backups/$(date +%F).dump`, keep 7 newest; cron line documented.
- `migrate-data.sh SOURCE_URL TARGET_URL`: (1) query source for policies/functions/views referencing schema `auth` (`pg_policies`, `pg_proc` bodies, `pg_views` definitions containing `auth.`) → print warning list and require `--force` to continue if non-empty; (2) `pg_dump -Fc --no-owner --no-acl -n public SOURCE`; (3) `pg_restore --no-owner --no-acl -d TARGET`; (4) row counts per table in `public` on both sides, print diff, exit 1 on mismatch. `MIGRATION.md`: cutover steps 1–6 from spec §7.9.1 including `npx prisma migrate status` check and rollback.
- `KronosFrontend/Dockerfile`: `node:24` build with `ARG VITE_API_URL VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY VITE_PUBLIC_URL`, `npm ci && npm run build`; `nginx:alpine` serving `dist` with `try_files $uri /index.html` (`nginx.conf`).
- `deploy/README.md`: VM order (data → worker → app), firewall (5432/6379 only from app+worker private IPs; worker no public ports; app 80/443), env var table per VM, and a "scaling to N API replicas" note: Caddy `reverse_proxy api1:3000 api2:3000 { lb_policy cookie }` for sticky sessions.

- [ ] **Step 1:** `docker build --target api -t sc-api .` and `docker build --target worker -t sc-worker .` → both succeed.
- [ ] **Step 2:** `docker build -t sc-frontend ../KronosFrontend` with dummy build args → succeeds.
- [ ] **Step 3:** Smoke: dev Postgres + Redis up; `docker run --rm --network host -e DATABASE_URL=... -e REDIS_URL=... sc-api` → migrations applied, `/health` ok; same for `sc-worker` on 3001.
- [ ] **Step 4:** Migration script dry check: run `migrate-data.sh` from dev DB A to empty dev DB B → counts match, exit 0; create a policy using `auth.uid()` in A (stub schema `auth` with function `uid()`) → script warns and stops without `--force`.
- [ ] **Step 5:** Commit `feat: docker targets, per-vm deploy files and data migration script` (backend repo). In KronosFrontend, leave the two new files uncommitted and report them.

### Task 11: Final verification

- [ ] **Step 1:** `npm run lint`, `npm run build`, `npx jest`, e2e realtime test with Redis → all green; paste outputs.
- [ ] **Step 2:** End-to-end manual check with `npm run start:dev`: with a task whose devices point to an unreachable IP, `POST /tasks/:id/measure` → `/kronos` `job:status` goes `queued → processing → retrying/failed` with the same `jobId`; `POST /devices/test-connection` to an unreachable IP returns failure within ~5 s.
- [ ] **Step 3:** Verify `grep -rn "@app/device-plugins" apps/api/src` returns nothing.
