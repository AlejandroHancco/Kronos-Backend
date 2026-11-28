import { Processor, Process, OnQueueFailed } from '@nestjs/bull';
import type { Job } from 'bull';
import { MEASUREMENTS_QUEUE, MeasurementJobData, SCHEDULED_MEASUREMENTS_QUEUE } from '@app/queue';
import { MeasurementJobRunner } from './measurement-job.runner';

/** Jobs procesados a la vez por cola y réplica: dispositivos distintos miden en paralelo. */
export const MEASUREMENT_CONCURRENCY = 4;

/**
 * Concurrencia de la cola programada: SCHEDULED_CONCURRENCY (entero ≥ 1), por defecto 4. Debe
 * cubrir los equipos distintos con puntos a la misma hora: con menos slots, un punto esperaría
 * turno en la cola y podría perderse. Se lee al cargar el módulo (el decorador se evalúa al
 * importar): debe estar en el entorno del proceso (env_file en docker), no solo en un .env local.
 */
export function scheduledConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SCHEDULED_CONCURRENCY);
  return Number.isInteger(value) && value >= 1 ? value : MEASUREMENT_CONCURRENCY;
}

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

  @Process({ name: 'execute', concurrency: scheduledConcurrency() })
  handleExecute(job: Job<MeasurementJobData>) {
    return this.runner.handleExecute(job);
  }

  @OnQueueFailed()
  onFailed(job: Job<MeasurementJobData>, error: Error) {
    return this.runner.onFailed(job, error);
  }
}
