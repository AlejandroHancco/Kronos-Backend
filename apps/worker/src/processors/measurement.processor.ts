import { Processor, Process, OnQueueFailed } from '@nestjs/bull';
import type { Job } from 'bull';
import { MEASUREMENTS_QUEUE, MeasurementJobData, SCHEDULED_MEASUREMENTS_QUEUE } from '@app/queue';
import { MeasurementJobRunner } from './measurement-job.runner';

/** Jobs procesados a la vez por cola y réplica: dispositivos distintos miden en paralelo. */
export const MEASUREMENT_CONCURRENCY = 4;

/**
 * Cola 'measurements' (mediciones manuales). Concurrencia 4: la exclusividad por dispositivo la
 * dan los locks Redis. La lógica vive en MeasurementJobRunner (compartida con la cola programada).
 * Reintentos: configurados al publicar el job (attempts: 3, backoff exponencial).
 */
@Processor(MEASUREMENTS_QUEUE)
export class MeasurementProcessor {
  constructor(private readonly runner: MeasurementJobRunner) {}

  @Process({ name: 'execute', concurrency: MEASUREMENT_CONCURRENCY })
  handleExecute(job: Job<MeasurementJobData>) {
    return this.runner.handleExecute(job);
  }

  @OnQueueFailed()
  onFailed(job: Job<MeasurementJobData>, error: Error) {
    return this.runner.onFailed(job, error);
  }
}

/**
 * Cola 'scheduled-measurements' (puntos de series programadas, publicados por el scheduler).
 * Cola propia: un manual esperando un equipo ocupado nunca ocupa el turno de un programado.
 */
@Processor(SCHEDULED_MEASUREMENTS_QUEUE)
export class ScheduledMeasurementProcessor {
  constructor(private readonly runner: MeasurementJobRunner) {}

  @Process({ name: 'execute', concurrency: MEASUREMENT_CONCURRENCY })
  handleExecute(job: Job<MeasurementJobData>) {
    return this.runner.handleExecute(job);
  }

  @OnQueueFailed()
  onFailed(job: Job<MeasurementJobData>, error: Error) {
    return this.runner.onFailed(job, error);
  }
}
