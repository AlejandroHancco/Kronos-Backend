/**
 * Contratos de "device plugin" inspirados directamente en IEEE Std 1876-2019
 * (Lab as a Service / LaaS), sección 4 — "First layer of standardization: LaaS".
 *
 * Cada dispositivo soportado por el Kronos Watcher implementa `DeviceDriverPlugin`.
 * measurements.service.ts nunca habla TCP/HTTP directamente con el hardware: resuelve
 * el plugin correspondiente al `device.type` vía `DevicePluginRegistry` y lo invoca a
 * través de esta interfaz. Así, agregar un dispositivo nuevo (type != 'analyzer') no
 * requiere tocar measurements.service.ts — solo registrar un nuevo plugin.
 *
 * Correspondencia con IEEE 1876-2019 (capa 1, cláusula 4):
 *   - SensorMetadata        → Tabla 14 (sensor)
 *   - SensorValueMetadata   → Tabla 15 (sensorValue)
 *   - AccessMode            → Tabla 18 (accessMode)
 *   - ActuatorMetadata      → Tabla 19 (actuator)
 *   - ActuatorValueMetadata → parte de la Tabla 19 (valores de entrada del actuator)
 *
 * Extensiones propias de Kronos (NO forman parte del estándar):
 *   - `simulated`, `connection` (DeviceConnection) y `channelSelection` (ChannelSelectionBinding)
 *     en DeviceServiceDescription;
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

/**
 * Extensión Kronos: el actuator selector de canal vive en OTRO registro Device
 * (ej. el MUX, device.type = hostDeviceType). Sin binding → el dispositivo no admite MUX.
 */
export interface ChannelSelectionBinding {
  actuatorId: string;
  hostDeviceType: string;
  hostLabel: string;
  required: boolean;
  connection: DeviceConnection;
}

/** Service description (4.2). */
export interface DeviceServiceDescription {
  deviceType: string;
  fullName: string;
  manufacturer: string;
  description: string;
  simulated: boolean;
  connection: DeviceConnection;
  sensors: SensorMetadata[];
  actuators: ActuatorMetadata[];
  channelSelection?: ChannelSelectionBinding;
}

/** Un punto medido: una frecuencia con sus valores de sensor por nombre (ej. {g, b}). */
export interface MeasuredPoint {
  frequency: number;
  values: Record<string, number>;
}

export interface MeasureChannelParams {
  analyzerIp: string;
  startFreq: number;
  stopFreq: number;
  points: number;
  sweepType: string;
}

export interface DeviceDriverPlugin {
  describe(): DeviceServiceDescription;

  /**
   * Equivalente a un chequeo de conectividad (usado también por el health check periódico).
   * `deviceType` distingue el sub-rol cuando un mismo plugin cubre más de un `device.type`
   * (ej. HiokiIm3570Plugin resuelve tanto "analyzer" como "mux").
   */
  testConnection(ip: string, deviceType: string, port?: number): Promise<boolean>;

  /** "setActuatorData" del selector de canal; obligatorio si describe().channelSelection existe. */
  selectChannel?(muxIp: string, channel: number): Promise<void>;

  /** "getSensorData": devuelve los sensorValues declarados por nombre. */
  measureChannel(params: MeasureChannelParams): Promise<MeasuredPoint[]>;
}
