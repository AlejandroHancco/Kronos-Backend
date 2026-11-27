# Measurement Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scheduled measurements run at their planned grid time; series can't collide on a device; late/lost points are bounded, recorded and never cascade; devices measure in parallel; disconnections alert people.

**Architecture:** Pure series arithmetic in `libs/measurement/src/series.ts` (occurrences, overlap, next reservation, reserved duration, suggestion) used by the api (admission at scheduling, manual runs, config changes) and the worker (dispatch window, delayed enqueue, missed marking). `ScheduledJob` carries the series grid and the outcome (`startedAt`, `delaySeconds`, `finishedAt`, `missed` + `missReason`). Device health gets a debounce and notifications; mail moves to a shared lib.

**Tech Stack:** NestJS 11 monorepo (apps/api, apps/worker, libs/*), Prisma 7 (schema `platform`), Bull, Redis, Jest; React + TanStack Query frontend.

**Spec:** `docs/superpowers/specs/2026-11-27-measurement-timing-design.md`

## Global Constraints
- Occurrence k (0-based) of a series: `seriesStartAt + k × intervalMinutes`; job `executionIndex = k + 1`; `startAt` = its planned time.
- `reservedSeconds = ceil(max(estimate, maxActualOfLast5) × 1.2)`, and at least `estimate + 60`.
- Window to start = `startAt + toleranceMinutes + 30 s grace`; tolerance default 5, allowed 0–30.
- Slot rule: may start only if `now + estimateSeconds ≤ next reservation start of its devices` (devices = sensorDeviceId + channelSelectorDeviceId of the task's active preference).
- `missReason` ∈ `'device_busy' | 'device_offline' | 'no_slot' | 'tolerance_exceeded' | 'system_down'`.
- Scheduler tick every 10 s; jobs ≤ 30 s from `startAt` are enqueued as Bull delayed jobs (`delay = startAt − now`).
- Measurement processor concurrency 4; device exclusivity via existing `RedisLockService.withDeviceLocks`.
- Offline after 2 consecutive failed health checks; online after 1 success.
- Device operations refused if they would start within 2 min of a reservation of that device.
- Commits: no Co-Authored-By or any AI attribution.

## Review Focus
- Daylight/timezone: occurrences computed in UTC milliseconds, never local wall-clock arithmetic. Test in Task 2 (series across a date boundary keeps exact spacing).
- Series with `intervalMinutes = null` (one-shot) and `repeatCount = 1` → single occurrence; overlap and next-reservation still work. Test in Task 2.
- Interval shorter than reservedSeconds (a series overlapping itself) → rejected at creation with a clear 400. Test in Task 3.
- Worker restarted mid-series → no duplicated next repetition and grid preserved. Test in Task 5.
- Retry after Bull failure outside the window → job marked missed, not measured. Test in Task 6.

---

### Task 1: Schema and migration

**Files:** Modify `prisma/schema.prisma` (ScheduledJob, ScheduledJobStatus); Create `prisma/migrations/20261128120000_measurement_timing/migration.sql`

**Interfaces — Produces:** `ScheduledJob.seriesStartAt DateTime @db.Timestamptz(6)`, `toleranceMinutes Int @default(5)`, `reservedSeconds Int @default(600)`, `startedAt DateTime?`, `finishedAt DateTime?`, `delaySeconds Int?`, `missReason String? @db.VarChar(40)`; enum value `missed`; index `@@index([status, startAt])`.

- [ ] **Step 1:** Edit schema; generate SQL with `prisma migrate diff --from-schema <HEAD schema> --to-schema prisma/schema.prisma --script`; add `ALTER TYPE ... ADD VALUE IF NOT EXISTS 'missed'` if diff emits it differently; backfill in the same migration: `seriesStartAt = "startAt" - ("executionIndex" - 1) * COALESCE("intervalMinutes",0) * interval '1 minute'` (column added nullable, backfilled, then `SET NOT NULL`).
- [ ] **Step 2:** `npx prisma generate && npx tsc --noEmit -p tsconfig.json && npx jest --ci` → clean (fix any compile errors from the new required field by passing `seriesStartAt` where jobs are created — the worker's next-repetition create is changed properly in Task 5; here just keep it compiling with `seriesStartAt: job.seriesStartAt`).
- [ ] **Step 3:** Commit `feat(db): scheduled job grid, tolerance and outcome fields`.

### Task 2: Series arithmetic (pure)

**Files:** Create `libs/measurement/src/series.ts`, `libs/measurement/src/series.spec.ts`; export from `libs/measurement/src/index.ts`

**Interfaces — Produces:**
```ts
export interface SeriesWindow { seriesStartAt: Date; intervalMinutes: number | null; firstIndex: number; lastIndex: number; reservedSeconds: number; }
// indexes are executionIndex values (1-based); a pending series covers firstIndex..lastIndex
export function occurrenceStart(s: Pick<SeriesWindow,'seriesStartAt'|'intervalMinutes'>, executionIndex: number): Date;
export function firstOverlap(a: SeriesWindow, b: SeriesWindow): { aIndex: number; bIndex: number; at: Date } | null;
export function selfOverlaps(s: SeriesWindow): boolean; // interval*60 < reservedSeconds with >1 occurrence
export function nextReservationStart(series: SeriesWindow[], after: Date): Date | null; // earliest occurrence start > after
export function reservedSecondsFor(estimateSeconds: number, actualDurationsSeconds: number[]): number;
export function suggestStart(candidate: Omit<SeriesWindow,'seriesStartAt'>, others: SeriesWindow[], from: Date, stepMinutes = 1, horizonHours = 24): Date | null;
```
- [ ] **Step 1: Failing tests** (`series.spec.ts`): occurrenceStart exact ms spacing across midnight; one-shot series; `firstOverlap` finds the first colliding pair for two 30-min series offset by 0 and returns null when offset by 15 min with reservedSeconds 600; overlap search must not iterate all 1344×1344 pairs (test with two 28-day series completes < 50 ms); `reservedSecondsFor(100,[])` = 160, `reservedSecondsFor(100,[150])` = 180, `reservedSecondsFor(600,[])` = 720; `suggestStart` returns the first minute where no overlap exists, null if none within horizon; `selfOverlaps` true for interval 5 min / reserved 600 s.
- [ ] **Step 2:** Run `npx jest libs/measurement/src/series.spec.ts` → FAIL.
- [ ] **Step 3:** Implement. Overlap: only the common time span matters; for each occurrence of the sparser series compute the candidate index range of the other by division, O(n) overall.
- [ ] **Step 4:** Tests pass; full `npx jest --ci`.
- [ ] **Step 5:** Commit `feat(measurement): series occurrence and overlap arithmetic`.

### Task 3: Scheduling admission (API)

**Files:** Create `apps/api/src/scheduled-jobs/series-reservations.service.ts` (+ spec); Modify `scheduled-jobs.service.ts`, `scheduled-jobs.controller.ts`, `dto/create-scheduled-job.dto.ts`, `scheduled-jobs.module.ts`, `apps/api/src/task-preferences/*.service.ts` (`updateTaskPreference`)

**Interfaces — Consumes:** Task 2 functions; `estimateSeconds` and experiment resolution (see how `MeasurementSchedulingService` estimates). **Produces:**
- `SeriesReservationsService.seriesForDevices(deviceIds: string[], excludeJobIds?: number[]): Promise<Array<SeriesWindow & { jobId: number; taskId: number; taskName: string; label: string | null }>>` — one entry per pending chain (the pending job of each chain covers `executionIndex..executionIndex+repeatCount−1`).
- `SeriesReservationsService.reservedSecondsForTask(taskId: number, channelCount: number): Promise<number>` — estimate + last 5 `finishedAt−startedAt` of the task's completed scheduled jobs.
- `SeriesReservationsService.assertNoConflict(candidate: SeriesWindow, deviceIds: string[], excludeJobIds?: number[]): Promise<void>` — throws `ConflictException({ message, conflicts: [{ jobId, taskName, label, at }], suggestedStartAt })`.
- `GET /scheduled-jobs/conflicts` → `Array<{ a: { jobId, taskName }, b: { jobId, taskName }, at }>`.
- DTO: `toleranceMinutes?: number` (`@IsInt @Min(0) @Max(30)`, default 5).

- [ ] **Step 1: Failing tests** (service spec, mocked prisma): create rejects overlap with 409 incl. `suggestedStartAt`; accepts a series on a different device at the same time; rejects a self-overlapping series with 400 'El intervalo es menor que la duración reservada de cada medición (X min)'; stores `seriesStartAt = startAt`, `reservedSeconds`, `toleranceMinutes`; `updateTaskPreference` that changes devices/ranges/channels of a task with pending series re-validates (409, preference not saved).
- [ ] **Step 2:** RED. **Step 3:** Implement. **Step 4:** GREEN + full suite + tsc. **Step 5:** Commit `feat(scheduling): reject colliding series at creation`.

### Task 4: Manual runs and device operations respect reservations

**Files:** Modify `apps/api/src/scheduler/scheduling.service.ts` (`findScheduledConflict` → uses `SeriesReservationsService.nextReservationStart` with `estimate × 1.2`), `apps/api/src/devices/device-configuration.service.ts` (and/or `devices.service.ts` where device-ops are enqueued) + specs

**Interfaces — Consumes:** Task 3 service (`seriesForDevices`), Task 2 `nextReservationStart`.

- [ ] **Step 1: Failing tests:** manual measurement whose `now + estimate×1.2` passes the next reservation → 409 'El equipo está reservado a las HH:MM; esta medición no terminaría a tiempo'; one that ends before → admitted; a device configuration operation within 2 min of a reservation of that device → 409.
- [ ] **Step 2–4:** RED → implement → GREEN + suite + tsc. **Step 5:** Commit `feat(scheduling): manual runs and device ops never invade reservations`.

### Task 5: Worker scheduler (grid, precise start, missed, catch-up)

**Files:** Modify `apps/worker/src/scheduler/scheduler.service.ts` (+ spec); worker module wiring for the reservations logic (move `SeriesReservationsService` to `libs/measurement` or `libs/database` if the worker needs it — keep one implementation).

**Interfaces — Produces:** job payload adds `plannedAt: string` (ISO) and `toleranceMinutes: number`; helper `markMissed(jobId: number, reason: MissReason)` that also creates the next repetition.

- [ ] **Step 1: Failing tests:** tick runs every 10 s (`@Interval(10_000)`); a pending job ≤ 30 s from `startAt` is enqueued with `delay = startAt − now` and status `running`; next repetition is created at `seriesStartAt + executionIndex × interval` (not `now`) — including when the current one is missed; a due job whose devices are busy/offline stays pending inside the window and is marked `missed` with `device_busy`/`device_offline` when the window closes, or `no_slot` when the next reservation forbids it; on startup/first tick a pending job whose window already passed by more than one interval creates `missed` rows with `system_down` for every skipped grid point and continues at the next future point; restarting does not duplicate the next repetition (create guarded by a unique check on `(taskId, seriesStartAt, executionIndex)` — add the unique index in this task's migration if needed).
- [ ] **Step 2–4:** RED → implement → GREEN + suite + tsc. **Step 5:** Commit `feat(worker): punctual grid scheduling with bounded lateness`.

### Task 6: Measurement processor (parallel devices, window re-check, outcome)

**Files:** Modify `apps/worker/src/processors/measurement.processor.ts` (+ spec), `libs/redis/src/redis-lock.service.ts` only if a per-call `waitTimeoutMs` is not already honoured (it is — `opts.waitTimeoutMs`).

- [ ] **Step 1: Failing tests:** `@Process({ name: 'execute', concurrency: 4 })`; for a scheduled job the lock wait is `max(0, windowEnd − now)`; inside the lock, before measuring, re-check window and slot → if failed mark `missed` (`tolerance_exceeded` / `no_slot`) and return without measuring (no Bull retry); on success write `startedAt` (lock acquired), `delaySeconds = round((startedAt − plannedAt)/1000)`, `finishedAt`, status `completed`; a retry attempt that starts outside the window marks missed instead of measuring; manual jobs unchanged.
- [ ] **Step 2–4:** RED → implement → GREEN + suite + tsc. **Step 5:** Commit `feat(worker): parallel devices and window-checked scheduled measurements`.

### Task 7: Disconnect alerts

**Files:** Move `apps/api/src/mail/*` to `libs/mail/src/*` (keep `apps/api` imports working via the lib; update tsconfig paths/jest moduleNameMapper like other libs); Modify `apps/worker/src/devices/device-health.service.ts` (+ spec), `libs/notifications/src/notification.writer.ts` (+ spec)

**Interfaces — Produces:** `NotificationWriter.notifyDeviceOffline(userIds: string[], device: { id; name }, atRisk: number)`, `notifyDeviceOnline(userIds: string[], device, downMinutes: number, lostPoints: number)`; email to team ADMINs: subject "KRONOS: <device> desconectado", text "<device> se desconectó a las HH:MM. N mediciones programadas en la próxima hora."

- [ ] **Step 1: Failing tests:** one failed check keeps `online`; two consecutive → `offline` + one bell per APPROVED member of the teams from `TeamScopeService.teamIdsForProject(device.projectId)` + one email per ADMIN; further failures send nothing more; recovery → `online` + notice with downtime minutes and count of jobs `missed` with `device_offline` during the outage; counter stored in Redis key `health:fail:<deviceId>`.
- [ ] **Step 2–4:** RED → implement → GREEN + suite + tsc. **Step 5:** Commit `feat(devices): disconnect and recovery alerts`.

### Task 8: Frontend

**Files (KronosFrontend):** Modify the schedule form (find it from `SweepConfigCard.tsx` "Programar Medición" → `src/api/tasks.api.ts`/`useTasks.ts` scheduled-job calls), `src/pages/calendar/CalendarPage.tsx`, the measurement history component used by `TaskDetailPage.tsx`; types in `src/types/*`.

- [ ] **Step 1:** Schedule form: field "Tolerancia de retraso (min)" (0–30, default 5); on 409 show the conflict list and a button "Usar HH:MM del DD/MM" that sets `startAt = suggestedStartAt`.
- [ ] **Step 2:** Calendar: one lane per device (measurement equipment / selector) within each day, block height from `reservedSeconds`, `missed` blocks greyed with reason on hover, delayed ones with "+X min", pre-existing conflicts from `GET /scheduled-jobs/conflicts` outlined in red.
- [ ] **Step 3:** History/task view: badge "Retrasada X min" when `delaySeconds > 0`; rows "Perdida — <motivo en español>" for missed repetitions (reasons: equipo ocupado, equipo desconectado, sin hueco, fuera de tolerancia, sistema detenido).
- [ ] **Step 4:** `npx tsc --noEmit -p tsconfig.app.json`, eslint on changed files, `npx vite build` → clean. **Step 5:** Commit `feat(scheduling): tolerance, conflicts and per-device calendar`.

### Task 9: Deploy and verify (controller)
- [ ] Push backend (`develop`) then frontend (`master`); confirm migration applied, worker healthy, a test series scheduled twice on the same device returns 409 with a suggestion.
