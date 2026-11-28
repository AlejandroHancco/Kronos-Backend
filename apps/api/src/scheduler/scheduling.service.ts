import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PrismaService } from '@app/database';
import type { AcquisitionMetadata, SweepRange } from '@app/laas-catalog';
import { estimateAcquisitionSeconds } from '@app/laas-catalog';
import { RealtimePublisher } from '@app/realtime';
import { MEASUREMENTS_QUEUE, MeasurementJobData, PRIORITY_MANUAL } from '@app/queue';
import { SeriesReservationsService, limaTime } from '@app/measurement';
import { ExperimentConfigService, ResolvedExperiment, toSweepRanges } from '@app/experiments';

/** Experimento resuelto + duración estimada de una ejecución (ver resolveWithEstimate). */
export interface ExecutionEstimate<R extends { points: number } = SweepRange> {
  resolved: ResolvedExperiment;
  ranges: R[];
  estimatedSeconds: number;
}

export interface AvailabilityResult {
  available: boolean;
  reason?: 'queue_full' | 'scheduled_conflict' | 'no_preference';
  message?: string;
  /** Duración estimada de ESTA medición (s) */
  estimatedSeconds: number;
  /** Trabajo ya encolado por delante (s) */
  backlogSeconds: number;
  /** Capacidad máxima de backlog aceptada (s) */
  maxBacklogSeconds: number;
  /** Próximo job programado que chocaría (si aplica) */
  nextScheduledAt?: Date;
}

/**
 * Control de admisión de mediciones manuales.
 * - Si el equipo está libre, la medición entra y corre de inmediato.
 * - Si hay cola, entra detrás de lo pendiente (concurrencia 1 por hardware).
 * - Se RECHAZA cuando el backlog superaría el máximo, o cuando terminaría
 *   pisando la siguiente reserva de una medición programada en los mismos dispositivos.
 */
@Injectable()
export class MeasurementSchedulingService {
  private readonly logger = new Logger(MeasurementSchedulingService.name);
  private readonly maxBacklogSeconds =
    Number(process.env.SCHEDULER_MAX_BACKLOG_SECONDS) || 15 * 60;

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimePublisher,
    private experimentConfig: ExperimentConfigService,
    @InjectQueue(MEASUREMENTS_QUEUE)
    private measurementQueue: Queue<MeasurementJobData>,
    private reservations: SeriesReservationsService,
  ) {}

  /** Estimación aditiva (ver acquisition.ts): canales × (cambio de canal + Σ rangos(setup + puntos·t)), desde la adquisición del dispositivo de medición. */
  estimateSeconds(
    acquisition: AcquisitionMetadata,
    ranges: { points: number }[],
    channelCount: number,
    hasSelector: boolean,
  ): number {
    return estimateAcquisitionSeconds(acquisition, ranges, channelCount, hasSelector);
  }

  /**
   * Resuelve el experimento activo de la tarea y estima la duración de una ejecución.
   * Compartido por la admisión manual (checkAvailability) y el cron de ScheduledJobs.
   * Sin `ranges` usa los rangos guardados en la configuración de la tarea.
   * null = la tarea no tiene equipo de medición asignado; los BadRequestException de resolve se propagan.
   */
  async resolveWithEstimate<R extends { points: number } = SweepRange>(
    taskId: number,
    channelCount: number,
    ranges?: R[],
  ): Promise<ExecutionEstimate<R> | null> {
    const resolved = await this.experimentConfig.resolve(taskId);
    if (!resolved) return null;
    const used = ranges ?? (toSweepRanges(resolved.preference.ranges) as unknown as R[]);
    const estimatedSeconds = this.estimateSeconds(resolved.acquisition, used, channelCount, !!resolved.selector);
    return { resolved, ranges: used, estimatedSeconds };
  }

  /** Segundos de trabajo pendiente/activo en la cola */
  async getBacklogSeconds(): Promise<number> {
    try {
      const jobs = await this.measurementQueue.getJobs(['waiting', 'active', 'delayed']);
      return jobs.reduce((sum, j) => sum + (j.data?.estimatedSeconds ?? 60), 0);
    } catch (err) {
      this.logger.warn(`No se pudo leer la cola (${err.message}) — backlog 0`);
      return 0;
    }
  }

  /**
   * ¿Se puede aceptar esta medición ahora?
   * 1. Backlog + estimación no debe superar el máximo.
   * 2. Debe terminar (×1.2) antes de la siguiente reserva de una serie programada
   *    que use los mismos dispositivos (equipo de medición / selector de canal).
   */
  async checkAvailability(
    taskId: number,
    ranges: { points: number }[],
    selectedChannels: number[],
  ): Promise<AvailabilityResult> {
    const backlogSeconds = await this.getBacklogSeconds();

    // Regla 0: la tarea necesita un equipo de medición asignado (TaskPreference; el MUX es opcional)
    // antes de poder medir — se valida aquí para que el 400 llegue de inmediato
    // en la respuesta HTTP, no minutos después cuando el worker ya lo intentó.
    // De paso resuelve el experimento: la duración depende de la adquisición del sensor.
    const estimate = await this.resolveWithEstimate(taskId, selectedChannels.length, ranges);
    if (!estimate) {
      return {
        estimatedSeconds: 0,
        backlogSeconds,
        maxBacklogSeconds: this.maxBacklogSeconds,
        available: false,
        reason: 'no_preference',
        message: 'Esta tarea no tiene un equipo de medición asignado. Configúralo antes de medir.',
      };
    }

    const { estimatedSeconds } = estimate;
    const base = {
      estimatedSeconds,
      backlogSeconds,
      maxBacklogSeconds: this.maxBacklogSeconds,
    };

    // Regla 1: cola llena
    if (backlogSeconds + estimatedSeconds > this.maxBacklogSeconds) {
      return {
        ...base,
        available: false,
        reason: 'queue_full',
        message:
          `La cola está llena: hay ~${Math.ceil(backlogSeconds / 60)} min de mediciones pendientes ` +
          `y esta medición añadiría ~${Math.ceil(estimatedSeconds / 60)} min más ` +
          `(máximo ${Math.ceil(this.maxBacklogSeconds / 60)} min). Intenta más tarde o reduce rangos/canales.`,
      };
    }

    // Regla 2: la medición (cola + estimación, con el mismo margen ×1.2 de las reservas) debe terminar
    // a más tardar cuando empiece la siguiente reserva de sus dispositivos (sensor + selector).
    const now = new Date();
    // ... y no puede empezar dentro de una reserva que ya está en curso.
    const running = await this.reservations.reservationNearForTask(taskId, now);
    if (running) {
      return {
        ...base,
        available: false,
        reason: 'scheduled_conflict',
        nextScheduledAt: running.end,
        message: `El equipo está en una reserva desde las ${limaTime(running.start)} (Lima)`,
      };
    }
    const nextReservation = await this.reservations.nextReservationForTask(taskId, now);
    if (nextReservation) {
      const endsAt = now.getTime() + Math.ceil(((backlogSeconds + estimatedSeconds) * 12) / 10) * 1000;
      if (endsAt > nextReservation.getTime()) {
        return {
          ...base,
          available: false,
          reason: 'scheduled_conflict',
          nextScheduledAt: nextReservation,
          message: `El equipo está reservado a las ${limaTime(nextReservation)}; esta medición no terminaría a tiempo`,
        };
      }
    }

    return { ...base, available: true };
  }

  /**
   * Punto de entrada del clic en "medir": valida admisión y encola.
   * Lanza 409 Conflict si no se puede aceptar.
   */
  async requestMeasurement(
    taskId: number,
    userId: string,
    params: {
      ranges: SweepRange[];
      selectedChannels: number[];
      jobId?: string;
    },
  ) {
    await this.experimentConfig.assertChannels(taskId, params.selectedChannels);
    const check = await this.checkAvailability(taskId, params.ranges, params.selectedChannels);
    if (!check.available) {
      throw new ConflictException({
        statusCode: 409,
        error: check.reason,
        message: check.message,
        estimatedSeconds: check.estimatedSeconds,
        backlogSeconds: check.backlogSeconds,
        maxBacklogSeconds: check.maxBacklogSeconds,
        nextScheduledAt: check.nextScheduledAt ?? null,
      });
    }

    const jobId = params.jobId || `${taskId}-${Date.now()}`;
    const payload: MeasurementJobData = {
      taskId,
      userId,
      ranges: params.ranges,
      selectedChannels: params.selectedChannels,
      jobId,
      estimatedSeconds: check.estimatedSeconds,
    };

    // job.id de Bull = payload.jobId: job:status (el processor emite String(job.id)) y
    // measurement:* (el ejecutor emite payload.jobId) comparten el mismo id, que es el devuelto.
    const job = await this.measurementQueue.add('execute', payload, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 100,
      priority: PRIORITY_MANUAL, // los ScheduledJobs (priority 1) pasan primero
    });

    this.realtime.jobStatus(userId, {
      jobId: String(job.id),
      taskId,
      status: 'queued',
    });

    return {
      jobId: String(job.id),
      status: 'queued' as const,
      estimatedSeconds: check.estimatedSeconds,
      estimatedWaitSeconds: check.backlogSeconds,
    };
  }
}
