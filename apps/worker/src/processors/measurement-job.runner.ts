import { Injectable, Logger } from '@nestjs/common';
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
import { MeasurementJobData } from '@app/queue';
import { SchedulerService } from '../scheduler/scheduler.service';

type ScheduledRow = {
  id: number;
  taskId: number;
  status: string;
  startAt: Date;
  seriesStartAt: Date;
  toleranceMinutes: number;
  startedAt: Date | null;
};

const rowSelect = {
  id: true,
  taskId: true,
  status: true,
  startAt: true,
  seriesStartAt: true,
  toleranceMinutes: true,
  startedAt: true,
} as const;

/**
 * Ejecución de un job de medición, compartida por las dos colas (una sola implementación):
 *  - 'measurements' (manuales): lock con la espera global DEVICE_LOCK_WAIT_MS, sin tocar ScheduledJob.
 *  - 'scheduled-measurements' (programados, scheduledJobId): cola propia para que un manual
 *    esperando un equipo ocupado nunca ocupe el turno de un programado. La espera del lock se
 *    limita a lo que queda de la ventana (inicio planificado + tolerancia + 30 s); con el lock
 *    tomado se vuelve a comprobar la ventana y el hueco (now + estimación ≤ próxima reserva de sus
 *    dispositivos, sin contar su propia cadena). Si algo falla el punto queda 'missed' (o 'failed'
 *    si un intento anterior ya había empezado a medir) y el job termina sin lanzar (Bull no
 *    reintenta). Toda escritura de estado es condicional a 'running': nunca pisa un punto que el
 *    reaper del scheduler ya resolvió.
 * La exclusividad por dispositivo la dan los locks Redis `lock:device:<id>`.
 */
@Injectable()
export class MeasurementJobRunner {
  private readonly logger = new Logger(MeasurementJobRunner.name);

  constructor(
    private readonly measurementExecutor: MeasurementExecutor,
    private readonly realtime: RealtimePublisher,
    private readonly prisma: PrismaService,
    private readonly lockService: RedisLockService,
    private readonly scheduler: SchedulerService,
    private readonly reservations: SeriesReservationsService,
  ) {}

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

    // null: punto programado no medido (missed / failed / ya resuelto); ya emitió su cierre
    if (result === null) return null;

    this.realtime.jobStatus(userId, {
      jobId: String(job.id),
      taskId,
      status: 'completed',
    });

    return result;
  }

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
   * hueco, startedAt/delaySeconds (solo el primer intento), medición, finishedAt/completed.
   * null = no se midió.
   */
  private async executeScheduled(job: Job<MeasurementJobData>) {
    const { taskId, scheduledJobId, estimatedSeconds } = job.data;
    const id = scheduledJobId!;

    const row = await this.readRow(id);
    if (!row || row.status !== 'running') return this.skip(job, row?.status ?? 'inexistente');

    const plannedAt = job.data.plannedAt ? new Date(job.data.plannedAt) : row.startAt;
    const windowEnd = toleranceWindowEnd(plannedAt, job.data.toleranceMinutes ?? row.toleranceMinutes);

    const waitMs = Math.max(0, windowEnd.getTime() - Date.now());
    if (waitMs === 0) return this.notMeasured(job, row, 'tolerance_exceeded');

    const preference = await this.readPreference(taskId);
    const devices = preference ? deviceIdsOf(preference) : [];

    const run = async () => {
      if (preference) await this.assertPreferenceUnchanged(taskId, preference);
      const lockedAt = new Date();
      const current = await this.readRow(id);
      if (!current || current.status !== 'running') return this.skip(job, current?.status ?? 'inexistente');
      if (lockedAt > windowEnd) return this.notMeasured(job, current, 'tolerance_exceeded');
      if (!(await this.slotFree(current, devices, plannedAt, lockedAt, estimatedSeconds))) {
        return this.notMeasured(job, current, 'no_slot');
      }

      // startedAt/delaySeconds los fija el primer intento que empieza a medir; un reintento los conserva
      if (!current.startedAt) {
        const started = await this.prisma.scheduledJob.updateMany({
          where: { id, status: 'running', startedAt: null },
          data: {
            startedAt: lockedAt,
            delaySeconds: Math.max(0, Math.round((lockedAt.getTime() - plannedAt.getTime()) / 1000)),
          },
        });
        if (started.count === 0) return this.skip(job, 'cambiada al empezar');
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

    // Solo un timeout al TOMAR los locks es "dispositivo ocupado"; lo que lance la medición se propaga.
    let acquired = false;
    try {
      return await this.lockService.withDeviceLocks(
        devices,
        () => {
          acquired = true;
          return run();
        },
        { waitTimeoutMs: waitMs },
      );
    } catch (error) {
      if (acquired || !(error instanceof DeviceBusyTimeoutError)) throw error;
      return this.notMeasured(job, row, (await this.anyOffline(devices)) ? 'device_offline' : 'device_busy');
    }
  }

  /** now + estimación ≤ próxima reserva (posterior al inicio planificado) de sus dispositivos, sin su propia cadena. */
  private async slotFree(
    row: ScheduledRow,
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

  /**
   * El punto no se mide: 'missed' con el motivo si ningún intento llegó a empezar; si un intento
   * anterior ya empezó (startedAt), 'failed' (condicional a running): se intentó y no se completó.
   */
  private async notMeasured(job: Job<MeasurementJobData>, row: ScheduledRow, reason: MissReason): Promise<null> {
    const { scheduledJobId, taskId, userId } = job.data;
    let error: string;
    if (row.startedAt) {
      await this.prisma.scheduledJob.updateMany({
        where: { id: scheduledJobId!, status: 'running' },
        data: { status: 'failed' },
      });
      this.logger.warn(`Scheduled job ${scheduledJobId}: reintento sin medir (${reason}); ya había empezado ⇒ failed`);
      error = `Medición programada fallida: el reintento no pudo empezar (${reason})`;
    } else {
      await this.scheduler.markMissed(scheduledJobId!, reason);
      error = `Medición programada perdida (${reason})`;
    }
    this.realtime.jobStatus(userId, { jobId: String(job.id), taskId, status: 'failed', error });
    return null;
  }

  /** La fila ya no está running (la resolvió otro, p. ej. el reaper): no se mide; se cierra el estado del cliente. */
  private skip(job: Job<MeasurementJobData>, status: string): null {
    const { scheduledJobId, taskId, userId } = job.data;
    this.logger.warn(`Scheduled job ${scheduledJobId} ya no está running (${status}); no se mide`);
    this.realtime.jobStatus(userId, {
      jobId: String(job.id),
      taskId,
      status: 'failed',
      error: `Medición programada ya resuelta (${status})`,
    });
    return null;
  }

  private readRow(id: number): Promise<ScheduledRow | null> {
    return this.prisma.scheduledJob.findUnique({ where: { id }, select: rowSelect });
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

  private readPreference(taskId: number): Promise<PrefDevices | null> {
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
  private async assertPreferenceUnchanged(taskId: number, locked: PrefDevices): Promise<void> {
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
