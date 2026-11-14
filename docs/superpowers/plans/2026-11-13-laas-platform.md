# LaaS Platform (API + Worker, IEEE 1876 layer 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `feat/laas-acquisition` into a LaaS server split across api/worker/data VMs, with plugins split into a pure catalog and worker-only drivers, device state in Redis, and the full `/laas/v1` service layer.

**Architecture:** Re-apply the approved monorepo split (reference spec + code on branch `feat/monorepo-api-worker`, read with `git show feat/monorepo-api-worker:<path>`) on top of the LaaS base. The API only reads metadata (`@app/laas-catalog`) and delegates every device I/O to the worker through Bull (`measurements`, `device-ops`). Shared state (locks, busy, last live values) lives in Redis.

**Tech Stack:** NestJS 11 monorepo (webpack), Prisma 7, Bull 4, ioredis 5, Socket.io 4 + `@socket.io/redis-emitter@5` / `@socket.io/redis-adapter@8`, Jest 30, Node 24, Docker, Caddy.

**Spec:** `docs/superpowers/specs/2026-11-13-laas-platform-design.md` (+ reference `docs/superpowers/specs/2026-11-13-monorepo-api-worker-design.md`).

## Global Constraints

- Branch `feat/laas-platform` (backend, from `origin/feat/laas-acquisition`); never push until the controller says so.
- **No `Co-Authored-By` (or any AI attribution) lines in commit messages.**
- HTTP/WS contract used by the frontend of `feat/laas-acquisition` unchanged: routes, LaaS field names, events, rooms `user:<id>`, `team:<id>`, `task:<id>`, raw `<userId>` in `/measurements`, socket auth middleware, `WS_AUTH_ERROR` + `disconnectSockets` on revocation. Only new routes are `/laas/v1/*`.
- `apps/api` must not import `@app/device-drivers` (nor anything that does, e.g. `@app/measurement`); only `apps/worker` opens connections to devices.
- `REDIS_URL` required by both apps (fail at bootstrap with `Error('REDIS_URL is required')`); no no-Redis fallback.
- Defaults: api `PORT=3000`; worker `HEALTH_PORT=3001`; `DEVICE_TEST_TIMEOUT_MS=5000`; `DEVICE_OP_TIMEOUT_MS=10000`; device lock TTL 60 000 ms renewed every 20 000 ms; `DEVICE_LOCK_WAIT_MS=900000`; leader TTL scheduler 55 000 ms, device-health 25 000 ms.
- Existing Spanish user-facing messages are kept verbatim (e.g. `"<name>" está midiendo; espera a que termine para cambiar su configuración`).
- vm-data starts with an empty DB (`prisma migrate deploy` + `npm run seed`); no data conversion.
- Node is not on PATH: `export PATH="/c/Users/hhancco/AppData/Roaming/fnm/node-versions/v24.22.3/installation:$PATH"`. Docker may be unavailable: skip only Docker/Redis-live steps and list them as Not run.

## Review Focus

- Worker offline: `GET /devices/:id/configuration` returns quickly with `live` values `null` (≤ `DEVICE_OP_TIMEOUT_MS`), `PUT` returns 504 `El laboratorio no respondió a tiempo`; nothing hangs. (Task 7)
- Clicking a MUX channel while that MUX is measuring → 409 with the existing message, MUX untouched. (Task 7)
- A model with a description but no driver (or vice versa) → worker refuses to boot naming the model; API still boots. (Task 4 / Task 8)
- `getSensorData?fresh=true` with a task whose sensor is a different device → 400; a device of another team → 404. (Task 11)
- `GET /laas/v1/metadata` is public and never leaks device instances (ids, IPs, names), even when devices exist. (Task 11)

## File Structure

```
apps/api/src/...                       current src/ (minus moved pieces) + laas/ (Task 11)
apps/worker/src/{main.ts,worker.module.ts,health.controller.ts}
apps/worker/src/scheduler/scheduler.service.ts
apps/worker/src/processors/{measurement.processor.ts,device-ops.processor.ts}
apps/worker/src/devices/device-health.service.ts
libs/database      PrismaModule, PrismaService
libs/redis         RedisModule (REDIS_CLIENT), RedisLockService, DeviceStateService, LiveValueStore
libs/queue         QueueModule, queue names, job payload types, DeviceOpsClient
libs/realtime      RealtimeModule, RealtimePublisher (own Redis client)
libs/common        TeamScopeService, decorators, validators
libs/notifications NotificationWriter
libs/laas-catalog  contract types, models/<model>/{service-description.json,index.ts}, LaasCatalog, acquisition, configuration, experiments (pure)
libs/device-drivers DeviceDriver, drivers/<model>/<model>.driver.ts, transports/, DeviceDriverRegistry
libs/measurement   MeasurementExecutor (generic measureTask), kronos-watcher, estimate
deploy/**, Dockerfile, .dockerignore, docker-compose.dev.yml, .env.example
```

---

### Task 0: Environment and baseline (controller)

- [ ] `git status` clean on `feat/laas-platform`; `npm ci && npx prisma generate && npm run build && npx jest` → record suite/test counts as baseline.

### Task 1: Monorepo scaffold (no behavior change)

**Files:** move `src/**` → `apps/api/src/**`, `test/` → `apps/api/test/` (`git mv`; on this OneDrive folder re-create moved dirs with a plain copy if jest stops discovering specs); `nest-cli.json`, `tsconfig.json` (`paths: {"@app/*": ["libs/*/src"]}`), `package.json`, `apps/api/tsconfig.app.json`, placeholder `apps/worker/{src/main.ts,src/worker.module.ts,tsconfig.app.json}`, `libs/.gitkeep`; delete `tsconfig.build.json`.

**Interfaces:** Produces `npm run build` (= `nest build api && nest build worker`, webpack) → `dist/apps/{api,worker}/main.js`; scripts `build:api`, `build:worker`, `start:api`, `start:worker`, `lint` = `eslint "{apps,libs}/**/*.ts" --fix`, `format` = `prettier --write "apps/**/*.ts" "libs/**/*.ts"`; jest `rootDir "."`, `roots ["<rootDir>/apps","<rootDir>/libs"]`, `moduleNameMapper {"^@app/(.*)$": "<rootDir>/libs/$1/src"}`, plus a mapper/transform so `*.json` imports of service descriptions resolve (`resolveJsonModule` already used).

- [ ] Port the shape of `git show feat/monorepo-api-worker:{nest-cli.json,package.json,apps/api/tsconfig.app.json,apps/api/test/jest-e2e.json}` adapting to this base's deps/scripts.
- [ ] `npm run build && npx jest` → same counts as baseline; `node dist/apps/api/main.js` reaches module init (no module-resolution error).
- [ ] Commit `refactor: convert backend to nest monorepo (apps/api)`.

### Task 2: Libs database, redis (+locks), common

**Files:** move `apps/api/src/prisma/{prisma.module,prisma.service}.ts` → `libs/database/src/`, `apps/api/src/redis/*` → `libs/redis/src/`, `apps/api/src/common/**` → `libs/common/src/` (guards that extend api-only guards stay in api); create `libs/redis/src/{redis.constants.ts,redis-lock.service.ts,redis-lock.service.spec.ts}` ported verbatim from `feat/monorepo-api-worker`; barrels + `tsconfig.lib.json` + nest-cli library entries; devDep `ioredis-mock`.

**Interfaces:** Produces `@app/database` (PrismaModule, PrismaService), `@app/common`, `@app/redis`: `RedisModule` (provider `REDIS_CLIENT`, throws `REDIS_URL is required`), `RedisLockService { tryAcquire(key, ttlMs): Promise<string|null>; renew(key, token, ttlMs): Promise<boolean>; release(key, token): Promise<void>; runAsLeader(name, ttlMs, fn): Promise<boolean>; withDeviceLocks<T>(ids, fn, opts?): Promise<T> }`, `DeviceBusyTimeoutError`.

- [ ] `libs/redis/src/redis.module.spec.ts`: compiling `RedisModule` without `REDIS_URL` rejects `/REDIS_URL is required/` → run (FAIL if base still returns null) → implement → PASS. Remove `@Optional()`/null branches of `REDIS_CLIENT` consumers keeping their try/catch degradation.
- [ ] Lock spec ported (6 cases) passes.
- [ ] `npm run build && npx jest` green; commit `refactor: extract database, redis and common libs with lock service`.

### Task 3: libs/realtime for this base's gateways

**Files:** `libs/realtime/src/{realtime.publisher.ts,realtime.redis.ts,realtime.module.ts,payloads.ts,index.ts}` + spec (port from `feat/monorepo-api-worker` final version, i.e. own client `REALTIME_REDIS_CLIENT` with offline queue, guarded publish); `apps/api/src/realtime/redis-io.adapter.ts` (ported, with error listeners); `apps/api/src/main.ts`; gateways keep auth middleware, joins, revocation; every `emit*` call site → publisher. Deps `@socket.io/redis-emitter@^5`, `@socket.io/redis-adapter@^8`.

**Interfaces:** `RealtimePublisher` methods as in the reference (`measurementComplete`, `jobStatus`, `notification`, `measurementProgress`, `measurementCompleted`, `measurementError`) **plus** `deviceStatus(deviceId: string, projectId: string, status: string): Promise<void>` → resolves team ids of the project with Prisma (same query the current `emitDeviceStatusChanged` uses) and emits `device:status` `{deviceId, projectId, status}` to each `team:<teamId>` in `/kronos`. Revocation (`WS_AUTH_ERROR` + `disconnectSockets(true)`) stays in the API gateways (works across replicas via the adapter).

- [ ] Spec: one test per method asserting namespace/room/event/payload equal to the removed gateway code; `deviceStatus` with a project in two teams emits twice to `team:t1`, `team:t2`; publish rejection is caught (no unhandled rejection).
- [ ] e2e `apps/api/test/realtime.e2e-spec.ts` ported (skips without `REDIS_URL`); `docker-compose.dev.yml` with `redis:7-alpine`.
- [ ] Green; commit `feat: publish realtime events via redis emitter and adapter`.

### Task 4: Split plugins into libs/laas-catalog (pure) and libs/device-drivers (I/O)

**Files:** `libs/laas-catalog/src/`: `contract.ts` (all types of `device-plugin.interface.ts` except the I/O plugin interfaces), `service-description.ts`, `acquisition.ts`, `configuration.ts`, `experiments.ts`, `experiment-config.ts` (pure parts), `laas-catalog.ts`, `models/<model>/{service-description.json,index.ts}` for the 6 models, `models/index.ts` (`DEVICE_MODELS`), `laas-catalog.module.ts`, specs moved. `libs/device-drivers/src/`: `device-driver.ts`, `drivers/<model>/<model>.driver.ts` (+ moved plugin specs, SCPI helpers), `transports/**`, `device-driver.registry.ts`, `drivers/index.ts` (`DEVICE_DRIVERS`), `device-drivers.module.ts`. API services that used `DevicePluginRegistry` for metadata switch to `LaasCatalog`.

**Interfaces (Produces):**
- `DeviceModelDefinition { description: DeviceServiceDescription; validateConfiguration?(effective: ConfigurationValues): string | null }` — Hioki and Agilent move their current `validateConfiguration` bodies here verbatim.
- `LaasCatalog` (injectable): `has(type)`, `describe(type): DeviceServiceDescription`, `role(type): DeviceRole | undefined` (from the description only: sensors ⇒ `sensor`, `channelSelector` ⇒ `channel-selector`, both/neither ⇒ throw at construction with the current messages), `channelSelector(type)` (same result shape as today's registry binding minus the plugin), `catalog(): DeviceTypeCatalogEntry[]`, `validateConfiguration(type, effective): string | null`. Errors keep current Spanish messages.
- `DeviceDriver { readonly deviceType: string; testConnection(target: ConnectionTarget): Promise<boolean>; getSensorData?(device, request): Promise<MeasuredPoint[]>; setActuatorData?(device, actuatorId, values): Promise<void>; readLiveConfiguration?(device): Promise<Record<string, ConfigurationValue|null>>; applyLiveConfiguration?(device, values): Promise<void> }`.
- `DeviceDriverRegistry`: `get(type)`, `sensor(type)` (has `getSensorData`), `actuator(type)` (has `setActuatorData`), `assertParity(catalog: LaasCatalog): void` — throws `Error` naming each model with description-but-no-driver, driver-but-no-description, sensor without `getSensorData`, selector without `setActuatorData`, live params without `applyLiveConfiguration`.
- Drivers are stateless: `KronosMux16Driver` drops its `channels` Map and does **not** implement `readLiveConfiguration` (Task 6 records live values).

- [ ] Specs: catalog role/selector/validation; `assertParity` (each failure kind, message contains the model id); driver specs moved (MUX: no longer tracks last channel).
- [ ] Intermediate state allowed: the api may still import `@app/device-drivers` for its remaining I/O call sites (`measureTask`, `testConnection`, live configuration) until Tasks 5, 7 and 8 move them; the "no drivers in api" grep is enforced in Task 9. Every commit must build and pass jest.
- [ ] Green; commit `refactor: split device plugins into pure laas catalog and worker drivers`.

### Task 5: libs/queue, libs/notifications, libs/measurement

**Files:** `libs/queue/src/{queue.module.ts,queue.constants.ts,jobs.ts,device-ops.client.ts,index.ts}`; `libs/notifications/src/*` (NotificationWriter, port reference); `libs/measurement/src/{measurement.executor.ts,measurement.module.ts,estimate.ts,kronos-watcher.ts,index.ts}` + specs. Remove no-Redis fallbacks in scheduling/scheduler services.

**Interfaces:**
- `@app/queue`: `MEASUREMENTS_QUEUE='measurements'`, `DEVICE_OPS_QUEUE='device-ops'`, `PRIORITY_SCHEDULED`, `PRIORITY_MANUAL` (values unchanged), `QueueModule` (`BullModule.forRootAsync` throwing `REDIS_URL is required` at bootstrap), `MeasurementJobData` (current fields), device-op payloads: `TestConnectionJob {type, ip, port}`, `ReadLiveConfigurationJob {deviceId}`, `ApplyLiveConfigurationJob {deviceId, values}`, `SetActuatorDataJob {deviceId, actuatorId, values}`.
- `DeviceOpsClient.request<T>(name: 'test-connection'|'read-live-configuration'|'apply-live-configuration'|'set-actuator-data', data, timeoutMs: number): Promise<T>` — port of the reference's fixed `waitForJobResult` (own `global:completed/failed` listeners removed in `finally`, state re-check, `removeOnComplete/removeOnFail: {age: 60}`, remove only if waiting/delayed/paused on timeout); throws `DeviceOpTimeoutError` on timeout and `DeviceOpFailedError(message)` with the worker's error message on failure.
- `@app/measurement`: `MeasurementExecutor.measureTask(taskId, userId, params)` = this base's generic `measureTask` moved verbatim except: uses `DeviceDriverRegistry` + `LaasCatalog`, `RealtimePublisher`, `NotificationWriter`; no `DeviceActivityService` (locks are the processor's job, Task 8). `estimateSeconds` from this base's per-device duration logic.

- [ ] Specs: `DeviceOpsClient` (success, timeout → `DeviceOpTimeoutError` + listeners removed, failed → `DeviceOpFailedError` with message, add rejects → timeout-like error, no pending timers); executor spec moved green.
- [ ] Green; commit `refactor: queue, notifications and measurement libs`.

### Task 6: Device state in Redis (busy, configuring, last live values)

**Files:** `libs/redis/src/{device-state.service.ts,live-value.store.ts}` + specs; delete `DeviceActivityService` and its spec; update its consumers.

**Interfaces (Produces):**
- `DeviceStateService`: `isBusy(deviceId): Promise<boolean>` = `lock:device:<id>` exists **or** id ∈ `runningJobDeviceIds(prisma)`; `withExclusive<T>(device: {id: string; name: string}, fn): Promise<T>` = `tryAcquire('lock:device:<id>', 60_000)`; if not acquired → `ConflictException('"<name>" está midiendo; espera a que termine para cambiar su configuración')`; releases in `finally`.
- `LiveValueStore`: `record(deviceId, values: ConfigurationValues): Promise<void>` (HSET `live:<deviceId>` + `updatedAt`), `read(deviceId): Promise<ConfigurationValues>`.

- [ ] Specs (ioredis-mock): busy via lock and via running job; `withExclusive` 409 while a measurement lock is held, runs when free, releases on throw; store round-trip.
- [ ] Green; commit `feat: device busy state and live values in redis`.

### Task 7: Device configuration and test-connection through the worker

**Files:** `apps/api/src/devices/devices.service.ts` (`testConnection` → `DeviceOpsClient` `test-connection`, timeout `DEVICE_TEST_TIMEOUT_MS`, same response messages), `apps/api/src/devices/device-configuration.service.ts` (moved from core; `view`: live values via `read-live-configuration` with `DEVICE_OP_TIMEOUT_MS`, on `DeviceOpTimeoutError`/failure → `null`; `busy` via `DeviceStateService.isBusy`; `apply`: same validation steps 1–5 using `LaasCatalog.validateConfiguration`, then live part via `apply-live-configuration` (timeout → `GatewayTimeoutException('El laboratorio no respondió a tiempo')`, failure → 502 with the current message), persisted part saved only after live succeeded, 409 when busy).

- [ ] Specs: worker offline → `view` returns `value: null` for live params within the timeout and `apply` → 504; busy device → 409 and no device op enqueued; persisted-only patch never enqueues a device op; success path persists merged values.
- [ ] Green; commit `feat: device configuration and connection tests run on the worker`.

### Task 8: Worker app

**Files:** `apps/worker/src/{main.ts,worker.module.ts,health.controller.ts}`, `scheduler/scheduler.service.ts` (moved; leader `scheduler` 55 000), `devices/device-health.service.ts` (moved; leader `device-health` 25 000; reachability via `DeviceDriverRegistry`), `processors/measurement.processor.ts` (moved; `withDeviceLocks([sensorDeviceId, channelSelectorDeviceId?])`, `jobId = String(job.id)`), `processors/device-ops.processor.ts` (new), specs. Port structure from `feat/monorepo-api-worker:apps/worker/**` (incl. `bootstrap().catch(exit 1)`, `unhandledRejection` log, `enableShutdownHooks`, `/health` 503).

**Interfaces:** `DeviceOpsProcessor` on `DEVICE_OPS_QUEUE`, concurrency 5:
- `test-connection` → `boolean` (unknown type → `false`).
- `read-live-configuration {deviceId}` → `driver.readLiveConfiguration` if implemented and non-null per key, else `LiveValueStore.read` value, else `null`.
- `apply-live-configuration {deviceId, values}` → `DeviceStateService.withExclusive` → `driver.applyLiveConfiguration` → `LiveValueStore.record`.
- `set-actuator-data {deviceId, actuatorId, values}` → validate against the actuator's `actuatorValues` ranges (400-equivalent error message `"<name>" debe estar entre <min> y <max>`), `withExclusive` → `driver.setActuatorData` → record values whose names match a `live` configuration parameter.
- Measurement channel switching inside `MeasurementExecutor` also records the selector value via `LiveValueStore` (Task 5 executor gets an optional `onActuatorApplied` hook or injects the store — implementer's choice, documented).
- Worker bootstrap calls `DeviceDriverRegistry.assertParity(LaasCatalog)`.

- [ ] Specs: module composition (providers present; no business controllers/gateways, via DiscoveryService metatype names); each device-op; busy → error carrying the 409 message; parity failure aborts bootstrap.
- [ ] Green; `node dist/apps/worker/main.js` without `REDIS_URL` exits 1 with `REDIS_URL is required`; commit `feat: worker app as the LaaS executor`.

### Task 9: API hardening and composition

**Files:** `apps/api/src/main.ts` (trust proxy 1, CORS `FRONTEND_URL ?? 'http://localhost:5173'` with credentials + `Content-Disposition`, `PORT`, shutdown hooks, `unhandledRejection` log, `bootstrap().catch`), `apps/api/src/health/health.controller.ts` (503 on error), `apps/api/src/app.module.spec.ts`.

- [ ] Spec: api module has none of `SchedulerService`, `MeasurementProcessor`, `DeviceHealthService`, `DeviceOpsProcessor`, `MeasurementExecutor`, `DeviceDriverRegistry` (DiscoveryService metatype names, with a positive control); health 200/503 cases.
- [ ] `grep -rn "@app/device-drivers\|@app/measurement" apps/api/src` → empty. Commit `feat: api hardening and composition checks`.

### Task 10: Measurement attribution columns

**Files:** `prisma/migrations/<timestamp>_measurement_device_attribution/migration.sql`, `prisma/schema.prisma` (`Measurement.sensorDeviceId String? @db.Uuid`, `sensorId String? @db.VarChar(100)`, `channelSelectorDeviceId String? @db.Uuid`, relations to `Device` with `onDelete: SetNull`, `@@index([sensorDeviceId, sensorId, takenAt(sort: Desc)])`, schema `platform`), `libs/measurement` executor fills them, `describe`'s `lastMeasured` uses them.

- [ ] Executor spec asserts the three columns are written; describe/lastMeasured spec uses `sensorDeviceId`.
- [ ] `npx prisma validate` + `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url ...` only if a DB is available (else Not run); green; commit `feat: attribute measurements to sensor and selector devices`.

### Task 11: `/laas/v1` service layer

**Files:** `apps/api/src/laas/{laas.module.ts,laas-metadata.service.ts,laas-metadata.controller.ts,laas-sensors.controller.ts,laas-actuators.controller.ts,laas-configuration.controller.ts,laas-experiments.controller.ts,laas-ids.ts,dto/*}` + specs.

**Interfaces:** routes, permissions and bodies exactly as spec §7.3/§7.4. `laas-ids.ts`: `toLaasId(deviceId, catalogId) = \`${deviceId}:${catalogId}\``, `parseLaasId(id): {deviceId, catalogId}` (400 `Identificador LaaS inválido` on bad format). Sensor/actuator metadata publish `protocol: 'http'` and `x-deviceProtocol: <catalog protocol>`; sensors include `sensorConfiguration` (Table 16: for `sweep` acquisition `start`, `stop` (double, unit of the declared variable), `points` (integer), `scale` (string); for `single` none) and `lastMeasured` from Task 10 columns. Metadata Table 1 from `LAAS_TITLE`, `LAAS_DESCRIPTION`, `LAAS_TERMS_URL`, `LAAS_CONTACT`, `LAAS_LICENSE`, `LAAS_LICENSE_URL`; `basePath` from `LAAS_BASE_URL` (default `http://localhost:3000/laas/v1`); `authorization` `{authorizationType: 'SSO protocol', keyName: 'Authorization', authServiceUrl: \`${SUPABASE_URL}/auth/v1\`}`; `concurrency: {interactionMode: 'asynchronous'}`; `apis`: one entry per route of §7.3 with an operation each (`nickname` = standard service name, e.g. `getSensorData`); `models`: one per response/body. `setActuatorData` → `DeviceOpsClient` `set-actuator-data` (busy 409, timeout 504, range 400). `fresh=true` → existing admission (`MeasurementSchedulingService.requestMeasurement`) with the task's ranges, returns 202.

- [ ] Specs: metadata contains every Table 1/2/3/4/5/6/7/9 field name, an operation for each of `getSensorMetadata, getSensorData, getActuatorMetadata, setActuatorData, getConfiguration, setConfiguration, getExperiment, getClients`, and no device instance data even when devices exist (Review Focus); metadata route has no auth guard; sensors/actuators list only team devices; getSensorData latest/404/`taskId` filter; fresh: 202 with `jobId`, 400 wrong sensor device, 404 other team; actuator 400 out of range, 409 busy, 504 timeout; experiments Table 20 shape with and without `projectId`; clients returns `FRONTEND_URL`.
- [ ] Green; commit `feat: IEEE 1876 LaaS service layer under /laas/v1`.

### Task 12: Dev workflow and env

**Files:** `package.json` (`start:dev` = `concurrently -n api,worker "nest start api --watch" "nest start worker --watch"`), `.env.example` (all vars read under `apps/` and `libs/`, incl. `DEVICE_OP_TIMEOUT_MS`, `LAAS_*`, placeholders only), `docker-compose.dev.yml` (+ `postgres:16-alpine` profile `db`), `README.md` dev/prod sections.

- [ ] `npm run build`, `npx jest` green; `start:dev` shows `[api]` and `[worker]`. Commit `chore: dev workflow for api + worker`.

### Task 13: Docker, deploy, frontend branch

**Files:** port `Dockerfile`, `.dockerignore`, `deploy/**` from `feat/monorepo-api-worker` HEAD (all fixes included); add `DEVICE_OP_TIMEOUT_MS`, `LAAS_*` to vm-app env example and README; README: first deploy runs `docker compose exec api npm run seed`; `deploy/vm-data/migrate-data.sh` + `MIGRATION.md`: schema `platform` instead of `public` (dump `-n platform`, empty-target precheck, row counts and restore gate on that schema). Frontend repo: branch `feat/laas-platform` from `origin/feat/laas-acquisition`, `git cherry-pick 3c2d34e` (Dockerfile + nginx.conf), adjust Dockerfile COPY list if the base added root files the build needs.

- [ ] `bash -n` on scripts; `docker compose -f <each> config` (temporary env, deleted); migrate-data.sh against stub pg tools: source with tables in `platform` → counts compared on `platform`. Docker builds → Not run if Docker unavailable.
- [ ] Commits: backend `feat: docker targets and per-vm deploy for the laas platform`; frontend `feat: add Dockerfile and nginx config for static deploy` (cherry-pick).

### Task 14: Final verification (controller)

- [ ] `npm run build`, `npx jest`, eslint summary for `libs/` and `apps/worker`, greps: no `@app/device-drivers`/`@app/measurement` in `apps/api/src`, no `apps/api` import in `apps/worker`/`libs`; frontend `npx tsc --noEmit -p tsconfig.app.json && npx vite build`.
