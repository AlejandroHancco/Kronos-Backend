import type {
  AcquisitionRequest,
  ConfigurationValue,
  ConfigurationValues,
  ConnectionTarget,
  DeviceContext,
  MeasuredPoint,
} from '@app/laas-catalog';

/**
 * Driver de E/S de un modelo de dispositivo (IEEE 1876 capa 1): lo único que habla con el equipo.
 * Su descripción vive en `@app/laas-catalog` (`models/<deviceType>/`); el driver no guarda estado
 * entre llamadas (con N workers, cualquier estado en memoria sería aleatorio).
 */
export interface DeviceDriver {
  readonly deviceType: string;

  /** Chequeo de conectividad (usado también por el health check periódico). */
  testConnection(target: ConnectionTarget): Promise<boolean>;

  /** "getSensorData" (Tablas 14/15): devuelve los sensorValues declarados por nombre. Obligatorio si declara sensores. */
  getSensorData?(device: DeviceContext, request: AcquisitionRequest): Promise<MeasuredPoint[]>;

  /** "setActuatorData" (Tabla 19). Obligatorio si declara channelSelector. */
  setActuatorData?(device: DeviceContext, actuatorId: string, values: Record<string, number>): Promise<void>;

  /** Lee los parámetros `live` del equipo (`null` = desconocido). Opcional: solo si el equipo permite leerlos. */
  readLiveConfiguration?(device: DeviceContext): Promise<Record<string, ConfigurationValue | null>>;

  /** Aplica parámetros `live` en el equipo. Obligatorio si declara alguno. */
  applyLiveConfiguration?(device: DeviceContext, values: ConfigurationValues): Promise<void>;
}

export type SensorDriver = DeviceDriver & Required<Pick<DeviceDriver, 'getSensorData'>>;
export type ActuatorDriver = DeviceDriver & Required<Pick<DeviceDriver, 'setActuatorData'>>;

export const isSensorDriver = (d: DeviceDriver): d is SensorDriver => typeof d.getSensorData === 'function';
export const isActuatorDriver = (d: DeviceDriver): d is ActuatorDriver => typeof d.setActuatorData === 'function';
