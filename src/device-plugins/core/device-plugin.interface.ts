/**
 * Contratos de "device plugin" inspirados directamente en IEEE Std 1876-2019
 * (Lab as a Service / LaaS), sección 4 — "First layer of standardization: LaaS".
 *
 * Cada modelo de dispositivo soportado por el Kronos Watcher es un plugin en
 * `plugins/<deviceType>/` con su `service-description.json`. Las capacidades están separadas:
 *   - `SensorPlugin`   → "getSensorData" (Tablas 14/15): mide y devuelve los sensorValues declarados;
 *   - `ActuatorPlugin` → "setActuatorData" (Tabla 19): por ahora, el selector de canal (MUX).
 * measurements.service.ts nunca habla TCP/HTTP con el hardware: resuelve el plugin del sensor
 * y el del selector por `device.type` vía `DevicePluginRegistry`.
 *
 * Correspondencia con IEEE 1876-2019 (capa 1, cláusula 4):
 *   - SensorMetadata        → Tabla 14 (sensor)
 *   - SensorValueMetadata   → Tabla 15 (sensorValue)
 *   - AccessMode            → Tabla 18 (accessMode)
 *   - ActuatorMetadata      → Tabla 19 (actuator)
 *   - ActuatorValueMetadata → parte de la Tabla 19 (valores de entrada del actuator)
 *
 * Extensiones propias de Kronos (NO forman parte del estándar):
 *   - `shortName`, `simulated`, `connection` (DeviceConnection), `channelSelector`
 *     (ChannelSelectorMetadata) y `configuration` en DeviceServiceDescription;
 *   - `fullName` a nivel superior de DeviceServiceDescription;
 *   - `label` en SensorValueMetadata (texto en español para leyendas);
 *   - `lastMeasured` es una aproximación: GET /devices/:id/describe lo deriva de la última
 *     medición de tareas cuya configuración actual usa el equipo.
 * Modos de acceso: solo se implementa `pull`; `push` y `stream` se declaran pero no se usan.
 */

export type AccessModeType = 'pull' | 'push' | 'stream';
export type ValueType = 'double' | 'integer' | 'string' | 'boolean';

/** Tabla 18 (accessMode). Kronos solo implementa 'pull' (push/stream fuera de alcance). */
export interface AccessMode {
  accessModeType: AccessModeType;
  nominalUpdateInterval?: number;
  userModifiableFrequency?: boolean;
}

/** Tabla 15 (sensorValue): un valor que produce un sensor. `label` es extensión Kronos (texto en español para leyendas). */
export interface SensorValueMetadata {
  name: string;
  unit: string;
  type: ValueType;
  label?: string;
  rangeMinimum?: number;
  rangeMaximum?: number;
  rangeStep?: number;
  updateFrequency?: number;
  /** ISO-8601; lo completa GET /devices/:id/describe cuando aplica. */
  lastMeasured?: string;
}

/** Tabla 14 (sensor) */
export interface SensorMetadata {
  sensorId: string;
  fullName: string;
  description: string;
  protocol: 'tcp' | 'http' | 'simulated';
  produces: string;
  sensorValues: SensorValueMetadata[];
  accessMode: AccessMode;
}

/** Parte de la Tabla 19: valores de entrada que acepta el actuator. */
export interface ActuatorValueMetadata {
  name: string;
  unit: string;
  type: ValueType;
  rangeMinimum?: number;
  rangeMaximum?: number;
  rangeStep?: number;
}

/** Tabla 19 (actuator) */
export interface ActuatorMetadata {
  actuatorId: string;
  fullName: string;
  description: string;
  protocol: 'tcp' | 'http' | 'simulated';
  inputType: ValueType;
  actuatorValues: ActuatorValueMetadata[];
  accessMode: AccessMode;
}

/** Extensión Kronos: cómo se alcanza el dispositivo. */
export interface DeviceConnection {
  requiresIp: boolean;
  defaultPort?: number;
}

/** Extensión Kronos: qué valor de qué actuator selecciona el canal (entero, con rango ≥ 1). */
export interface ChannelSelectorMetadata {
  actuatorId: string;
  valueName: string;
}

export type ConfigurationValue = number | string | boolean;
export type ConfigurationValues = Record<string, ConfigurationValue>;

/**
 * Extensión Kronos, modelada sobre la Tabla 15: un parámetro configurable del dispositivo
 * (getConfiguration/setConfiguration), no parte del estándar.
 */
export interface ConfigurationParameterMetadata {
  name: string;
  label: string;
  description?: string;
  type: ValueType;
  unit: string;
  rangeMinimum?: number;
  rangeMaximum?: number;
  rangeStep?: number;
  allowedValues?: Array<string | number>;
  /** Obligatorio para storage 'fixed' y 'persisted'. */
  default?: ConfigurationValue;
  access: 'read-only' | 'read-write';
  storage: 'fixed' | 'persisted' | 'live';
}

/** Service description (4.2). */
export interface DeviceServiceDescription {
  deviceType: string;
  fullName: string;
  /** Extensión Kronos: nombre corto para catálogos y UI. */
  shortName: string;
  manufacturer: string;
  description: string;
  simulated: boolean;
  connection: DeviceConnection;
  sensors: SensorMetadata[];
  actuators: ActuatorMetadata[];
  /** Extensión Kronos: qué actuator/valor selecciona el canal. */
  channelSelector?: ChannelSelectorMetadata;
  /** Extensión Kronos: parámetros configurables del dispositivo. */
  configuration: ConfigurationParameterMetadata[];
}

/** Instancia concreta de dispositivo (fila `devices`) que recibe un plugin. */
export interface DeviceContext {
  id: string;
  name: string;
  ip: string | null;
  configuration: ConfigurationValues;
}

/** Un punto medido: una frecuencia con sus valores de sensor por nombre (ej. {g, b}). */
export interface MeasuredPoint {
  frequency: number;
  values: Record<string, number>;
}

/** Rol de un tipo de dispositivo, derivado de sus capacidades (ver `roleOf` en el registry). */
export type DeviceRole = 'sensor' | 'channel-selector';

/** Destino de un chequeo de conectividad. */
export interface ConnectionTarget {
  ip: string | null;
  port?: number;
}

/** Un barrido de frecuencia que el sensor ejecuta. */
export interface SweepParams {
  startFreq: number;
  stopFreq: number;
  points: number;
  sweepType: string;
}

export interface DevicePlugin {
  describe(): DeviceServiceDescription;

  /** Chequeo de conectividad (usado también por el health check periódico). */
  testConnection(target: ConnectionTarget): Promise<boolean>;

  /** Reglas entre campos de la configuración efectiva; `null` si es válida. */
  validateConfiguration?(effective: ConfigurationValues): string | null;

  /** Lee los parámetros `live` del dispositivo (`null` = desconocido). Obligatorio si declara alguno. */
  readLiveConfiguration?(device: DeviceContext): Promise<Record<string, ConfigurationValue | null>>;

  /** Aplica parámetros `live` en el dispositivo. Obligatorio si declara alguno. */
  applyLiveConfiguration?(device: DeviceContext, values: ConfigurationValues): Promise<void>;
}

/** Capacidad "getSensorData" (Tablas 14/15): devuelve los sensorValues declarados por nombre. */
export interface SensorPlugin extends DevicePlugin {
  getSensorData(device: DeviceContext, sweep: SweepParams): Promise<MeasuredPoint[]>;
}

/** Capacidad "setActuatorData" (Tabla 19). */
export interface ActuatorPlugin extends DevicePlugin {
  setActuatorData(device: DeviceContext, actuatorId: string, values: Record<string, number>): Promise<void>;
}

export const isSensorPlugin = (p: DevicePlugin): p is SensorPlugin =>
  typeof (p as SensorPlugin).getSensorData === 'function';

export const isActuatorPlugin = (p: DevicePlugin): p is ActuatorPlugin =>
  typeof (p as ActuatorPlugin).setActuatorData === 'function';
