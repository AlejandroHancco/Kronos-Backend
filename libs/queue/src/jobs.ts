import type { ConfigurationValues, SweepRange } from '@app/laas-catalog';

/** Payload de los jobs de la cola 'measurements' */
export interface MeasurementJobData {
  taskId: number;
  userId: string;
  ranges: SweepRange[];
  selectedChannels: number[];
  jobId: string;
  /** Duración estimada (segundos) — usada para calcular el backlog de la cola */
  estimatedSeconds: number;
  /** Presentes solo cuando la medición proviene de un ScheduledJob */
  scheduledJobId?: number;
  executionIndex?: number;
  /** Inicio planificado (ISO) de esta ocurrencia en la rejilla de la serie */
  plannedAt?: string;
  /** Minutos de retraso admitidos (más la gracia fija de 30 s) */
  toleranceMinutes?: number;
}

/** Payloads de los jobs de la cola 'device-ops' (la API los publica, el worker los ejecuta) */
export interface TestConnectionJob {
  type: string;
  ip: string;
  port: number;
}

export interface ReadLiveConfigurationJob {
  deviceId: string;
}

export interface ApplyLiveConfigurationJob {
  deviceId: string;
  values: ConfigurationValues;
}

export interface SetActuatorDataJob {
  deviceId: string;
  actuatorId: string;
  values: Record<string, number>;
}

export type DeviceOpName =
  | 'test-connection'
  | 'read-live-configuration'
  | 'apply-live-configuration'
  | 'set-actuator-data';

export type DeviceOpData = TestConnectionJob | ReadLiveConfigurationJob | ApplyLiveConfigurationJob | SetActuatorDataJob;

/** Payload de los jobs de la cola 'mail' (correo saliente; sin `html` la API lo genera del texto). */
export interface MailJob {
  to: string;
  subject: string;
  text: string;
  html?: string;
}
