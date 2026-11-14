import type { MeasurementRange } from '@app/measurement';

/** Payload de los jobs de la cola 'measurements' */
export interface MeasurementJobData {
  taskId: number;
  userId: string;
  ranges: MeasurementRange[];
  selectedChannels: number[];
  jobId: string;
  /** Duración estimada (segundos) — usada para calcular el backlog de la cola */
  estimatedSeconds: number;
  /** Presentes solo cuando la medición proviene de un ScheduledJob */
  scheduledJobId?: number;
  executionIndex?: number;
}

/** Payload de los jobs de la cola 'device-ops' (test de conexión) */
export interface TestConnectionJobData {
  type: string;
  ip: string;
  port: number;
}
