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
