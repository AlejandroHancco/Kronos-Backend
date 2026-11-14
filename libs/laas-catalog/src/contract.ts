/**
 * Contrato LaaS (puro, sin E/S) inspirado directamente en IEEE Std 1876-2019
 * (Lab as a Service / LaaS), sección 4 — "First layer of standardization: LaaS".
 *
 * Cada modelo de dispositivo soportado por el Kronos Watcher son dos piezas:
 *   - `@app/laas-catalog`: `models/<deviceType>/` con su `service-description.json` y su
 *     `DeviceModelDefinition` (descripción + validación de configuración). Lo usa la API.
 *   - `@app/device-drivers`: `drivers/<deviceType>/` con su driver de E/S ("getSensorData"
 *     Tablas 14/15, "setActuatorData" Tabla 19, testConnection, configuración live). Solo el worker.
 * El rol de cada modelo (sensor o selector de canal) se deriva únicamente de su descripción.
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
 *   - `acquisition` en SensorMetadata (sweep | single);
 *   - `lastMeasured` es una aproximación: GET /devices/:id/describe lo deriva de la última
 *     medición de tareas cuya configuración actual usa el equipo.
 * Modos de acceso: solo se implementa `pull`; `push` y `stream` se declaran pero no se usan.
 */

import type { AcquisitionMetadata } from './acquisition';

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
  /** Extensión Kronos: cómo adquiere (barrido sobre una variable declarada o lectura puntual). */
  acquisition: AcquisitionMetadata;
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

/** Instancia concreta de dispositivo (fila `devices`) que recibe un driver. */
export interface DeviceContext {
  id: string;
  name: string;
  ip: string | null;
  configuration: ConfigurationValues;
}

/** Un punto medido: valor de la variable del barrido (`x`, ausente en lecturas puntuales) y los sensorValues por nombre. */
export interface MeasuredPoint {
  x?: number;
  values: Record<string, number>;
}

/** Rol de un tipo de dispositivo, derivado de su descripción (ver `roleOf` en laas-catalog.ts). */
export type DeviceRole = 'sensor' | 'channel-selector';

/** Destino de un chequeo de conectividad. */
export interface ConnectionTarget {
  ip: string | null;
  port?: number;
}

/**
 * Definición pura de un modelo de dispositivo (sin E/S): su service description y, opcionalmente,
 * reglas entre campos de la configuración efectiva. La E/S del modelo vive en su driver
 * (`@app/device-drivers`), que solo carga el worker.
 */
export interface DeviceModelDefinition {
  description: DeviceServiceDescription;

  /** Reglas entre campos de la configuración efectiva; `null` si es válida. */
  validateConfiguration?(effective: ConfigurationValues): string | null;
}
