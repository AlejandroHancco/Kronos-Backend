# Puntualidad de mediciones programadas, concurrencia de equipos y alertas de desconexión

## Intent
In concrete curing tests the value of a series depends on **regular intervals**: a measurement
that runs a few minutes late, or a delay that pushes the following ones, spoils the series. Today
two series can be scheduled on the same device at the same time (nothing checks it), a busy device
silently postpones a scheduled measurement, and nobody is told when a device disconnects. The owner
wants scheduled measurements to happen **at their planned time**, conflicts to be impossible by
construction, every late or lost point to be visible, and an alert when a device disconnects.

## Findings in the current code (drive the design)
- `apps/worker/src/scheduler/scheduler.service.ts` runs **once per minute**, so a measurement can
  start up to ~60 s late even when everything is free.
- The next repetition is created as `now + intervalMinutes` (dispatch time), not
  `plannedStart + interval`: **every delay is inherited by all later repetitions (drift / chain
  effect)** — exactly what the owner fears.
- Busy device ⇒ the job stays `pending` and is retried next tick with no limit and no trace.
- `POST /scheduled-jobs` does not check overlaps with other series on the same devices.
- Manual measurements already have an admission check against scheduled jobs
  (`apps/api/src/scheduler/scheduling.service.ts`, `findScheduledConflict`) but without margin.
- `DeviceHealthService` (worker, every 30 s) flips `device.status` online/offline and emits a
  WebSocket event; no notification or email.
- Calendar (`KronosFrontend/src/pages/calendar/CalendarPage.tsx`) mixes all devices in one column and
  draws every block as 10 minutes.

## Goals
1. Every repetition has a fixed planned time: `seriesStart + k × interval`, independent of when
   earlier repetitions actually ran.
2. Scheduling is rejected when any repetition would overlap another series on the same measurement
   equipment or channel selector; the error says what it collides with and suggests the next free
   start time for the whole series.
3. Late start is allowed only within the series' **tolerance** (default 5 min, configurable per
   series, 0 allowed) **and** only if the measurement still finishes before the next reservation of
   the same devices; otherwise the point is **skipped and marked lost** with a reason. A late or lost
   point never delays another measurement.
4. Every executed point records its planned and actual start (delay); lost points record why.
5. Manual measurements and device configuration changes never invade a reservation.
6. Calendar shows each device separately with blocks of the reserved duration, and lost/late points.
7. Device disconnection alert (bell + email to group admins) after 2 consecutive failed health
   checks, including how many scheduled measurements are at risk in the next hour; a recovery notice
   with the downtime.

## Non-goals
- No automatic rescheduling/shifting of a series; no reordering by priority between series.
- No new measurement hardware logic; drivers unchanged.

## Anti-goals
- Any mechanism that delays measurement N+1 because measurement N was late.
- Silent postponement or silent loss of a point.
- Alert storms from a device that flaps for a second (needs the 2-check debounce) or one alert per
  missed point (one disconnect alert + one recovery notice per outage).

## Approaches (picked: 1 — Claude's recommendation; the owner approved the behaviour, not the internals)
1. **Reservations computed from the series (no new reservation table)** *(chosen)*. A series is
   (start, interval, repeatCount, devices, reservedSeconds); occurrence k occupies
   `[start + k·interval, start + k·interval + reservedSeconds)`. Overlap between two series is
   checked arithmetically over their occurrences in the overlapping time span. Small data, no
   1 344-row materialisation per series, easy to keep in sync.
2. Materialise one reservation row per occurrence. Simple queries, but thousands of rows per
   series to create/cancel/keep consistent when tasks or devices change. Rejected.
3. Keep runtime-only protection (locks + tolerance) without scheduling-time checks. Conflicts would
   still be discovered when it is too late. Rejected (goal 2).

## Design

### Data
- `ScheduledJob` gains: `seriesStartAt` (planned start of execution 1; copied to every repetition),
  `toleranceMinutes Int @default(5)`, `reservedSeconds Int` (computed at creation), `startedAt?`
  (actual start), `delaySeconds Int?`, `missReason String?`.
- New status `missed` in `ScheduledJobStatus` (with `missReason`: `'device_busy' | 'device_offline' |
  'no_slot' | 'tolerance_exceeded' | 'system_down'`).
- Each job's own `startAt` = its planned time = `seriesStartAt + (executionIndex − 1) × interval`.
- Existing pending jobs: migration backfills `seriesStartAt = startAt − (executionIndex − 1) ×
  interval`, `reservedSeconds` from the current estimate (or 600 s if it cannot be computed),
  `toleranceMinutes = 5`.

### Reserved duration
`reservedSeconds = ceil(max(estimateSeconds(current config), max actual duration of the task's last
5 measurements) × 1.2)`, at least `estimate + 60 s`. Recomputed when the series is created and when
the task's experiment/ranges/channels change (see "Config changes").

### Scheduling-time check (API)
- `POST /scheduled-jobs` (and any edit) computes the devices (sensor + selector of the task's
  active preference) and checks every other pending series sharing any of those devices for
  overlapping occurrences. Conflict ⇒ 409 `{ message, conflicts: [{ jobLabel, taskName, at }],
  suggestedStartAt }` where `suggestedStartAt` is the earliest start ≥ requested start (searched in
  1-minute steps up to 24 h) at which the whole series fits.
- `GET /scheduled-jobs/conflicts` lists pre-existing overlaps (series created before this change) so
  the calendar can flag them.

### Runtime (worker)
- Scheduler tick every **10 s** (leader lock as today).
- A due job (`startAt ≤ now`, `pending`) is dispatched when its devices are free and online.
- If not dispatchable: keep waiting while `now ≤ startAt + toleranceMinutes` **and**
  `now + estimateSeconds ≤ next reservation start of the same devices`; when either fails, mark it
  `missed` with the reason (`device_offline` if the health state is offline, `device_busy` otherwise,
  `no_slot` when the next reservation is the limit, `tolerance_exceeded` when the window is the
  limit).
- On dispatch record `startedAt` and `delaySeconds = startedAt − startAt`.
- The next repetition is created at `seriesStartAt + executionIndex × interval` (planned, not
  `now`), **also when the current one is missed**, so the series always continues on its grid.
- Measurements produced by a scheduled job keep `takenAt` = real time (already the case) so analysis
  uses the true time.

### Manual measurements and configuration changes
- Manual "Medir barrido": allowed only if `now + estimate × 1.2` ends before the next reservation
  of the same devices (extend `findScheduledConflict` with the margin); otherwise 409 with the time
  the device is free until.
- Changing a task's experiment/devices/ranges/channels while it has pending series re-validates
  that series' reservations (new devices and new `reservedSeconds`); conflict ⇒ 409, change not saved.
- Device operations that lock a device (configuration writes) are rejected if they would start
  within 2 minutes of a reservation of that device.

### Disconnection alerts
- `DeviceHealthService` keeps a consecutive-failure counter per device (Redis); status becomes
  `offline` only after **2 consecutive** failed checks (~1 min), and `online` after 1 success.
- On online→offline: notification (bell) to every APPROVED member of the device's project's team,
  plus email to that team's ADMINs: "<device> se desconectó a las HH:MM. N mediciones programadas
  en la próxima hora." One notification per outage.
- On offline→online: notification "<device> volvió a estar disponible (desconectado X min)" and
  the count of points lost during the outage.

### Frontend
- Schedule form: "Tolerancia de retraso (min)" (default 5, 0–30); on 409 show the conflicts and a
  button "Usar <suggestedStartAt>".
- Calendar: one lane per device (measurement equipment and selector) or a device selector
  (builder's choice) so overlaps are visible; block height = `reservedSeconds`; markers for
  `missed` (with reason on hover) and delayed points (`delaySeconds > 0`); pre-existing conflicts
  highlighted.
- Measurement history / task view: badge "Retrasada X min" and "Perdida (motivo)" rows for missed
  repetitions.

## Rules settled after the builder check (Claude's calls)
- **Different devices measure in parallel.** Today `MeasurementProcessor` handles one job at a time
  (single worker), so a long sweep on device A would make device B late. The processor runs with
  concurrency (e.g. 4) and the existing Redis device locks guarantee exclusivity per device; two
  jobs sharing a device can never run together. Without this, goal 3 cannot hold.
- **A point "starts" when the processor holds the device locks and is about to measure.** That is
  where `startedAt`/`delaySeconds` are written. Before measuring (first attempt and every retry) the
  processor re-checks the window (`now ≤ startAt + tolerance + grace`) and the slot
  (`now + estimate ≤ next reservation of its devices`); if either fails it marks the job `missed`
  instead of measuring. Lock wait is capped to the remaining window (not the global
  `DEVICE_LOCK_WAIT_MS`). Bull retries of a scheduled job are allowed only while still inside the
  window.
- **Precise start:** the scheduler enqueues a job as a Bull *delayed* job when it is ≤ 30 s from
  `startAt` (delay = `startAt − now`), so it fires on time instead of waiting for a tick.
  A fixed **grace of 30 s** is added to every tolerance; "tolerance 0" means "within 30 s".
- **Worker/scheduler down:** on the first tick after an outage, every grid point whose window has
  already passed is recorded as `missed` with reason **`system_down`** (one row per point, so no loss
  is silent), and the series continues at its next future grid point.
- **Disconnect alert recipients:** the teams of the device's project are derived with
  `TeamScopeService.teamIdsForProject`; bell to all APPROVED members of those teams; email to their
  `TeamMember` ADMIN + APPROVED users. `MailService` moves from `apps/api` to a shared lib so the
  worker can send it.
- **Actual durations:** `ScheduledJob` gains `finishedAt`; reserved time uses the actual durations
  (`finishedAt − startedAt`) of the task's last 5 executed scheduled jobs when available; otherwise
  the estimate only (× 1.2, ≥ estimate + 60 s). Manual runs are not tracked for this.

## Constraints
- Same stack and rules as the rest of the project (NestJS monorepo api/worker, Prisma 7 schema
  `platform`, migrations replayable on an empty DB, Bull queues, notifications lib, Brevo mail).
- Commits without Co-Authored-By/AI attribution.

## Left to the builder
- Exact overlap algorithm (arithmetic over the common span), calendar layout details, notification
  copy beyond the texts above, indexes.
