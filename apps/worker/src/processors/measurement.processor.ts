import { Logger } from '@nestjs/common';
import { Processor, Process, OnQueueFailed } from '@nestjs/bull';
import type { Job } from 'bull';
import { PrefDevices, PrismaService, deviceIdsOf } from '@app/database';
import {
  MeasurementExecutor,
  MissReason,
  SeriesReservationsService,
  nextReservationStart,
  toleranceWindowEnd,
} from '@app/measurement';
import { RealtimePublisher } from '@app/realtime';
import { DeviceBusyTimeoutError, RedisLockService } from '@app/redis';
import { MEASUREMENTS_QUEUE, MeasurementJobData } from '@app/queue';
import { SchedulerService } from '../scheduler/scheduler.service';

/** Jobs de la cola procesados a la vez por réplica: dispositivos distintos miden en paralelo. */
const CONCURRENCY = 4;

type Preference = PrefDevices;

/**
 * Procesador de la cola 'measurements'.
 * Concurrencia 4: jobs de dispositivos distintos miden en paralelo (una medición larga en el equipo
 * A no retrasa al equipo B). La exclusividad por dispositivo — dentro de la réplica, entre réplicas
 * y frente a un cambio de configuración — la dan los locks Redis `lock:device:<id>` del equipo de
 * medición y del selector de canal: dos jobs que comparten un dispositivo nunca corren a la vez.
 *
 * Jobs programados (scheduledJobId): la espera del lock se limita a lo que queda de la ventana
 * (inicio planificado + tolerancia + 30 s); con el lock tomado se vuelve a comprobar la ventana y
 * el hueco (now + estimación ≤ próxima reserva de sus dispositivos, sin contar su propia cadena).
 * Si algo falla el punto queda 'missed' y el job termina sin lanzar (Bull no reintenta). Un
 * reintento que empieza fuera de la ventana también queda 'missed'. Toda escritura de estado es
 * condicional a 'running': nunca pisa un punto que el reaper del scheduler ya resolvió.
 * Jobs manuales: sin cambios (lock con la espera global DEVICE_LOCK_WAIT_MS).
 *
 * Reintentos: configurados al publicar el job (attempts: 3, backoff exponencial).
 */
@Processor(MEASUREMENTS_QUEUE)
export class MeasurementProcessor {
  private readonly logger = new Logger(MeasurementProcessor.name);

  constructor(
    private readonly measurementExecutor: MeasurementExecutor,
    private readonly realtime: RealtimePublisher,
    private readonly prisma: PrismaService,
    private readonly lockService: RedisLockService,
    private readonly scheduler: SchedulerService,
    private readonly reservations: SeriesReservationsService,
  ) {}

  @Process({ name: 'execute', concurrency: CONCURRENCY })
  async handleExecute(job: Job<MeasurementJobData>) {
    const { taskId, userId } = job.data;

    this.logger.log(
      `Processing measurement job ${job.id} (task ${taskId}, attempt ${job.attemptsMade + 1}/${job.opts.attempts})`,
    );

    this.realtime.jobStatus(userId, {
      jobId: String(job.id),
      taskId,
      status: 'processing',
      attempt: job.attemptsMade + 1,
    });

    const result = job.data.scheduledJobId ? await this.executeScheduled(job) : await this.executeManual(job);

    if (result === null) return null; // punto programado perdido (missed) o ya resuelto: sin medición

    this.realtime.jobStatus(userId, {
      jobId: String(job.id),
      taskId,
      status: 'completed',
    });

    return result;
  }

  @OnQueueFailed()
  async onFailed(job: Job<MeasurementJobData>, error: Error) {
    const { taskId, userId, scheduledJobId } = job.data;
    const maxAttempts = job.opts.attempts ?? 1;
    const willRetry = job.attemptsMade < maxAttempts;

    this.logger.error(
      `Measurement job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
    );

    // Fallo definitivo (sin más reintentos) de un ScheduledJob → marcar failed (si sigue running)
    if (!willRetry && scheduledJobId) {
      await this.prisma.scheduledJob
        .updateMany({
          where: { id: scheduledJobId, status: 'running' },
          data: { status: 'failed' },
        })
        .catch((err) =>
          this.logger.error(`No se pudo marcar scheduled job ${scheduledJobId} como failed: ${err.message}`),
        );
    }

    this.realtime.jobStatus(userId, {
      jobId: String(job.id),
      taskId,
      status: willRetry ? 'retrying' : 'failed',
      attempt: job.attemptsMade,
      error: error.message,
    });
  }

  /** Medición manual: locks con la espera global; sin preferencia, measureTask falla con su propio error. */
  private async executeManual(job: Job<MeasurementJobData>) {
    const { taskId } = job.data;
    const preference = await this.readPreference(taskId);
    if (!preference) return this.measure(job);
    return this.lockService.withDeviceLocks(deviceIdsOf(preference), async () => {
      await this.assertPreferenceUnchanged(taskId, preference);
      return this.measure(job);
    });
  }

  /**
   * Punto programado: espera del lock acotada a la ventana; con el lock, re-chequeo de ventana y
   * hueco, startedAt/delaySeconds, medición, finishedAt/completed. null = no se midió.
   */
  private async executeScheduled(job: Job<MeasurementJobData>) {
    const { taskId, scheduledJobId, estimatedSeconds } = job.data;
    const id = scheduledJobId!;

    const row = await this.prisma.scheduledJob.findUnique({
      where: { id },
      select: { id: true, taskId: true, status: true, startAt: true, seriesStartAt: true, toleranceMinutes: true },
    });
    if (!row || row.status !== 'running') {
      this.logger.warn(`Scheduled job ${id} ya no está running (${row?.status ?? 'inexistente'}); no se mide`);
      return null;
    }

    const plannedAt = job.data.plannedAt ? new Date(job.data.plannedAt) : row.startAt;
    const windowEnd = toleranceWindowEnd(plannedAt, job.data.toleranceMinutes ?? row.toleranceMinutes);

    const waitMs = Math.max(0, windowEnd.getTime() - Date.now());
    if (waitMs === 0) return this.miss(job, 'tolerance_exceeded');

    const preference = await this.readPreference(taskId);
    const devices = preference ? deviceIdsOf(preference) : [];

    const run = async () => {
      if (preference) await this.assertPreferenceUnchanged(taskId, preference);
      const startedAt = new Date();
      if (startedAt > windowEnd) return this.miss(job, 'tolerance_exceeded');
      if (!(await this.slotFree(row, devices, plannedAt, startedAt, estimatedSeconds))) return this.miss(job, 'no_slot');

      const started = await this.prisma.scheduledJob.updateMany({
        where: { id, status: 'running' },
        data: {
          startedAt,
          delaySeconds: Math.max(0, Math.round((startedAt.getTime() - plannedAt.getTime()) / 1000)),
        },
      });
      if (started.count === 0) {
        this.logger.warn(`Scheduled job ${id} ya no está running al empezar; no se mide`);
        return null;
      }

      const result = await this.measure(job);

      const done = await this.prisma.scheduledJob.updateMany({
        where: { id, status: 'running' },
        data: { status: 'completed', finishedAt: new Date() },
      });
      if (done.count === 0) {
        this.logger.warn(`Scheduled job ${id} ya no estaba running al terminar; la medición se guardó igual`);
      }
      return result;
    };

    if (devices.length === 0) return run(); // sin preferencia: measureTask falla con su propio error

    try {
      return await this.lockService.withDeviceLocks(devices, run, { waitTimeoutMs: waitMs });
    } catch (error) {
      if (!(error instanceof DeviceBusyTimeoutError)) throw error;
      return this.miss(job, (await this.anyOffline(devices)) ? 'device_offline' : 'device_busy');
    }
  }

  /** now + estimación ≤ próxima reserva (posterior al inicio planificado) de sus dispositivos, sin su propia cadena. */
  private async slotFree(
    row: { id: number; taskId: number; seriesStartAt: Date },
    devices: string[],
    plannedAt: Date,
    now: Date,
    estimatedSeconds: number,
  ): Promise<boolean> {
    if (devices.length === 0) return true;
    const projectId = (await this.reservations.projectOfTask(row.taskId)) ?? undefined;
    const ownChain = (s: { taskId: number; seriesStartAt: Date }) =>
      s.taskId === row.taskId && s.seriesStartAt.getTime() === row.seriesStartAt.getTime();
    const series = [
      ...(await this.reservations.seriesForDevices(devices, [row.id], projectId)),
      ...(await this.reservations.runningForDevices(devices, [row.id], projectId)),
    ].filter((s) => !ownChain(s));
    const next = nextReservationStart(series, plannedAt);
    return !next || now.getTime() + estimatedSeconds * 1000 <= next.getTime();
  }

  private async miss(job: Job<MeasurementJobData>, reason: MissReason): Promise<null> {
    const { scheduledJobId, taskId, userId } = job.data;
    await this.scheduler.markMissed(scheduledJobId!, reason);
    this.realtime.jobStatus(userId, {
      jobId: String(job.id),
      taskId,
      status: 'failed',
      error: `Medición programada perdida (${reason})`,
    });
    return null;
  }

  /** Ejecuta la medición con los plugins del experimento, guarda en DB y emite measurement:complete. */
  private measure(job: Job<MeasurementJobData>) {
    const { taskId, userId, ranges, selectedChannels, jobId, scheduledJobId, executionIndex } = job.data;
    return this.measurementExecutor.measureTask(taskId, userId, {
      ranges,
      selectedChannels,
      jobId,
      scheduledJobId,
      executionIndex,
    });
  }

  private readPreference(taskId: number): Promise<Preference | null> {
    return this.prisma.taskPreference.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      select: { sensorDeviceId: true, channelSelectorDeviceId: true },
    });
  }

  /**
   * La espera del lock puede durar minutos: measureTask vuelve a resolver la preferencia dentro del
   * lock, así que si ahora usa un dispositivo que NO bloqueamos, se aborta este intento y Bull
   * reintenta tomando los locks de la configuración nueva.
   */
  private async assertPreferenceUnchanged(taskId: number, locked: Preference): Promise<void> {
    const lockedIds = new Set(deviceIdsOf(locked));
    const current = await this.readPreference(taskId);
    if (current && !deviceIdsOf(current).every((id) => lockedIds.has(id))) {
      throw new Error('La configuración de la tarea cambió mientras esperaba el equipo; se reintentará');
    }
  }

  private async anyOffline(deviceIds: string[]): Promise<boolean> {
    const devices = await this.prisma.device.findMany({
      where: { id: { in: deviceIds } },
      select: { id: true, status: true },
    });
    return devices.some((d) => d.status === 'offline');
  }
}
