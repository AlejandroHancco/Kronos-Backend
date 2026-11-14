import { Logger } from '@nestjs/common';
import { Processor, Process, OnQueueFailed } from '@nestjs/bull';
import type { Job } from 'bull';
import { PrismaService } from '@app/database';
import { MeasurementExecutor } from '@app/measurement';
import { RealtimePublisher } from '@app/realtime';
import { RedisLockService } from '@app/redis';
import { MEASUREMENTS_QUEUE, MeasurementJobData } from '@app/queue';

/**
 * Procesador de la cola 'measurements'.
 * Concurrencia 1 (default de Bull): el MUX/analyzer solo soporta
 * una medición a la vez — nunca subir la concurrencia de este processor.
 * Entre réplicas del worker, la exclusividad la dan los locks Redis por dispositivo.
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
  ) {}

  @Process('execute')
  async handleExecute(job: Job<MeasurementJobData>) {
    const { taskId, userId, ranges, selectedChannels, jobId, scheduledJobId, executionIndex } =
      job.data;

    this.logger.log(
      `Processing measurement job ${job.id} (task ${taskId}, attempt ${job.attemptsMade + 1}/${job.opts.attempts})`,
    );

    this.realtime.jobStatus(userId, {
      jobId: String(job.id),
      taskId,
      status: 'processing',
      attempt: job.attemptsMade + 1,
    });

    // Ejecuta la medición vía TCP (SCPI Hioki + MUX HTTP), guarda en DB
    // y emite measurement:complete a la sala de la tarea (dentro de measureTask).
    const measure = () =>
      this.measurementExecutor.measureTask(taskId, userId, {
        ranges,
        selectedChannels,
        jobId,
        scheduledJobId,
        executionIndex,
      });

    // Exclusividad entre réplicas: lock Redis sobre el MUX y el analyzer de la
    // preferencia activa. Sin preferencia, measureTask falla con su propio error.
    const preference = await this.prisma.taskPreference.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      select: { analyzerDeviceId: true, muxDeviceId: true },
    });
    const result = preference
      ? await this.lockService.withDeviceLocks(
          [preference.muxDeviceId, preference.analyzerDeviceId],
          measure,
        )
      : await measure();

    // Si vino de un ScheduledJob, marcarlo como completado
    if (scheduledJobId) {
      await this.prisma.scheduledJob.update({
        where: { id: scheduledJobId },
        data: { status: 'completed' },
      });
    }

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

    // Fallo definitivo (sin más reintentos) de un ScheduledJob → marcar failed
    if (!willRetry && scheduledJobId) {
      await this.prisma.scheduledJob
        .update({
          where: { id: scheduledJobId },
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
}
