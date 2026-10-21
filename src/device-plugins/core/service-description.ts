import { parameterValueError } from './configuration';
import { parseAcquisition } from './acquisition';
import type {
  AccessMode,
  AccessModeType,
  ActuatorMetadata,
  ActuatorValueMetadata,
  ChannelSelectorMetadata,
  ConfigurationParameterMetadata,
  DeviceConnection,
  DeviceServiceDescription,
  SensorMetadata,
  SensorValueMetadata,
  ValueType,
} from './device-plugin.interface';

const DEVICE_TYPE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VALUE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const PROTOCOLS = ['tcp', 'http', 'simulated'] as const;
const VALUE_TYPES: readonly ValueType[] = ['double', 'integer', 'string', 'boolean'];
const ACCESS_MODE_TYPES: readonly AccessModeType[] = ['pull', 'push', 'stream'];
const ACCESS_KINDS = ['read-only', 'read-write'] as const;
const STORAGE_KINDS = ['fixed', 'persisted', 'live'] as const;

function fail(path: string, problem: string): never {
  throw new Error(`${path}: ${problem}`);
}

function record(path: string, v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'debe ser un objeto');
  return v as Record<string, unknown>;
}

function arr(path: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) fail(path, 'debe ser un arreglo');
  return v;
}

function str(path: string, v: unknown): string {
  if (typeof v !== 'string') fail(path, 'debe ser un texto');
  return v;
}

function bool(path: string, v: unknown): boolean {
  if (typeof v !== 'boolean') fail(path, 'debe ser verdadero o falso');
  return v;
}

function num(path: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'debe ser un número');
  return v;
}

function optNum(path: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  return num(path, v);
}

function oneOf<T extends string>(path: string, v: unknown, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    fail(path, `debe ser uno de: ${values.join(', ')}`);
  }
  return v as T;
}

function accessMode(path: string, v: unknown): AccessMode {
  const o = record(path, v);
  const accessModeType = oneOf(`${path}.accessModeType`, o.accessModeType, ACCESS_MODE_TYPES);
  const out: AccessMode = { accessModeType };
  if (o.nominalUpdateInterval !== undefined) out.nominalUpdateInterval = num(`${path}.nominalUpdateInterval`, o.nominalUpdateInterval);
  if (o.userModifiableFrequency !== undefined) out.userModifiableFrequency = bool(`${path}.userModifiableFrequency`, o.userModifiableFrequency);
  return out;
}

function sensorValue(path: string, v: unknown): SensorValueMetadata {
  const o = record(path, v);
  const name = str(`${path}.name`, o.name);
  if (!VALUE_NAME_PATTERN.test(name)) fail(`${path}.name`, 'debe cumplir ^[a-z][a-z0-9_]*$ (se usa como columna CSV)');
  const out: SensorValueMetadata = {
    name,
    unit: str(`${path}.unit`, o.unit),
    type: oneOf(`${path}.type`, o.type, VALUE_TYPES),
  };
  if (o.label !== undefined) out.label = str(`${path}.label`, o.label);
  if (o.rangeMinimum !== undefined) out.rangeMinimum = num(`${path}.rangeMinimum`, o.rangeMinimum);
  if (o.rangeMaximum !== undefined) out.rangeMaximum = num(`${path}.rangeMaximum`, o.rangeMaximum);
  if (o.rangeStep !== undefined) out.rangeStep = num(`${path}.rangeStep`, o.rangeStep);
  if (o.updateFrequency !== undefined) out.updateFrequency = num(`${path}.updateFrequency`, o.updateFrequency);
  if (o.lastMeasured !== undefined) out.lastMeasured = str(`${path}.lastMeasured`, o.lastMeasured);
  return out;
}

function sensor(path: string, v: unknown, usedValueNames: Set<string>): SensorMetadata {
  const o = record(path, v);
  const sensorValues = arr(`${path}.sensorValues`, o.sensorValues).map((sv, i) => sensorValue(`${path}.sensorValues[${i}]`, sv));
  for (const sv of sensorValues) {
    if (usedValueNames.has(sv.name)) fail(`${path}.sensorValues`, `sensorValue repetido "${sv.name}"`);
    usedValueNames.add(sv.name);
  }
  return {
    sensorId: str(`${path}.sensorId`, o.sensorId),
    fullName: str(`${path}.fullName`, o.fullName),
    description: str(`${path}.description`, o.description),
    protocol: oneOf(`${path}.protocol`, o.protocol, PROTOCOLS),
    produces: str(`${path}.produces`, o.produces),
    sensorValues,
    accessMode: accessMode(`${path}.accessMode`, o.accessMode),
    acquisition: parseAcquisition(`${path}.acquisition`, o.acquisition),
  };
}

function actuatorValue(path: string, v: unknown): ActuatorValueMetadata {
  const o = record(path, v);
  const out: ActuatorValueMetadata = {
    name: str(`${path}.name`, o.name),
    unit: str(`${path}.unit`, o.unit),
    type: oneOf(`${path}.type`, o.type, VALUE_TYPES),
  };
  if (o.rangeMinimum !== undefined) out.rangeMinimum = num(`${path}.rangeMinimum`, o.rangeMinimum);
  if (o.rangeMaximum !== undefined) out.rangeMaximum = num(`${path}.rangeMaximum`, o.rangeMaximum);
  if (o.rangeStep !== undefined) out.rangeStep = num(`${path}.rangeStep`, o.rangeStep);
  return out;
}

function actuator(path: string, v: unknown): ActuatorMetadata {
  const o = record(path, v);
  return {
    actuatorId: str(`${path}.actuatorId`, o.actuatorId),
    fullName: str(`${path}.fullName`, o.fullName),
    description: str(`${path}.description`, o.description),
    protocol: oneOf(`${path}.protocol`, o.protocol, PROTOCOLS),
    inputType: oneOf(`${path}.inputType`, o.inputType, VALUE_TYPES),
    actuatorValues: arr(`${path}.actuatorValues`, o.actuatorValues).map((av, i) => actuatorValue(`${path}.actuatorValues[${i}]`, av)),
    accessMode: accessMode(`${path}.accessMode`, o.accessMode),
  };
}

function connection(path: string, v: unknown): DeviceConnection {
  const o = record(path, v);
  const out: DeviceConnection = { requiresIp: bool(`${path}.requiresIp`, o.requiresIp) };
  if (o.defaultPort !== undefined) {
    const port = num(`${path}.defaultPort`, o.defaultPort);
    if (port < 1 || port > 65535) fail(`${path}.defaultPort`, 'debe estar entre 1 y 65535');
    out.defaultPort = port;
  }
  return out;
}

function channelSelector(path: string, v: unknown, actuators: ActuatorMetadata[]): ChannelSelectorMetadata {
  const o = record(path, v);
  const actuatorId = str(`${path}.actuatorId`, o.actuatorId);
  const valueName = str(`${path}.valueName`, o.valueName);
  const act = actuators.find((a) => a.actuatorId === actuatorId);
  if (!act) fail(path, `no existe un actuator "${actuatorId}"`);
  const value = act.actuatorValues.find((av) => av.name === valueName);
  if (!value) fail(path, `el actuator "${actuatorId}" no declara el valor "${valueName}"`);
  if (value.type !== 'integer') fail(path, `el valor "${valueName}" debe ser entero`);
  if (value.rangeMinimum === undefined || !Number.isInteger(value.rangeMinimum) || value.rangeMinimum < 1) {
    fail(path, `el valor "${valueName}" debe declarar rangeMinimum entero ≥ 1`);
  }
  if (value.rangeMaximum === undefined || value.rangeMaximum < value.rangeMinimum) {
    fail(path, `el valor "${valueName}" debe declarar rangeMaximum ≥ rangeMinimum`);
  }
  return { actuatorId, valueName };
}

function configurationParameter(path: string, v: unknown): ConfigurationParameterMetadata {
  const o = record(path, v);
  const name = str(`${path}.name`, o.name);
  const label = str(`${path}.label`, o.label);
  const type = oneOf(`${path}.type`, o.type, VALUE_TYPES);
  const unit = str(`${path}.unit`, o.unit);
  const access = oneOf(`${path}.access`, o.access, ACCESS_KINDS);
  const storage = oneOf(`${path}.storage`, o.storage, STORAGE_KINDS);

  const out: ConfigurationParameterMetadata = { name, label, type, unit, access, storage };
  if (o.description !== undefined) out.description = str(`${path}.description`, o.description);
  if (o.rangeMinimum !== undefined) out.rangeMinimum = num(`${path}.rangeMinimum`, o.rangeMinimum);
  if (o.rangeMaximum !== undefined) out.rangeMaximum = num(`${path}.rangeMaximum`, o.rangeMaximum);
  if (o.rangeStep !== undefined) out.rangeStep = num(`${path}.rangeStep`, o.rangeStep);
  if (o.allowedValues !== undefined) {
    const allowedValues = arr(`${path}.allowedValues`, o.allowedValues);
    for (let i = 0; i < allowedValues.length; i++) {
      const val = allowedValues[i];
      if (typeof val !== 'string' && (typeof val !== 'number' || !Number.isFinite(val))) {
        fail(`${path}.allowedValues[${i}]`, 'debe ser un texto o un número');
      }
    }
    out.allowedValues = allowedValues as Array<string | number>;
  }

  const namedPath = `${path} (${name})`;
  if (storage === 'fixed' && access !== 'read-only') {
    fail(namedPath, 'debe ser de solo lectura ("read-only") si storage es "fixed"');
  }
  if (storage === 'fixed' || storage === 'persisted') {
    if (o.default === undefined) fail(namedPath, 'falta "default"');
    out.default = o.default as ConfigurationParameterMetadata['default'];
    const err = parameterValueError(out, out.default);
    if (err) fail(namedPath, err);
  }
  return out;
}

function parseDescription(raw: unknown): DeviceServiceDescription {
  const o = record('', raw);

  const deviceType = str('deviceType', o.deviceType);
  if (!DEVICE_TYPE_PATTERN.test(deviceType) || deviceType.length > 50) {
    fail('deviceType', 'debe cumplir ^[a-z0-9]+(-[a-z0-9]+)*$ y tener a lo sumo 50 caracteres');
  }

  const fullName = str('fullName', o.fullName);
  const shortName = str('shortName', o.shortName);
  const manufacturer = str('manufacturer', o.manufacturer);
  const description = str('description', o.description);
  const simulated = bool('simulated', o.simulated);
  const conn = connection('connection', o.connection);

  const usedValueNames = new Set<string>();
  const sensors = arr('sensors', o.sensors).map((s, i) => sensor(`sensors[${i}]`, s, usedValueNames));
  const kinds = new Set(sensors.map((s) => s.acquisition.kind));
  if (kinds.size > 1) fail('sensors', 'todos los sensores de un dispositivo deben declarar el mismo tipo de adquisición');
  const actuators = arr('actuators', o.actuators).map((a, i) => actuator(`actuators[${i}]`, a));
  const configuration = arr('configuration', o.configuration ?? []).map((c, i) => configurationParameter(`configuration[${i}]`, c));

  const usedParameterNames = new Set<string>();
  for (let i = 0; i < configuration.length; i++) {
    const param = configuration[i];
    if (usedParameterNames.has(param.name)) fail(`configuration[${i}].name`, `nombre de parámetro repetido "${param.name}"`);
    usedParameterNames.add(param.name);
  }

  const out: DeviceServiceDescription = {
    deviceType,
    fullName,
    shortName,
    manufacturer,
    description,
    simulated,
    connection: conn,
    sensors,
    actuators,
    configuration,
  };

  if (o.channelSelector !== undefined) {
    out.channelSelector = channelSelector('channelSelector', o.channelSelector, actuators);
  }

  return out;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Valida y congela un `service-description.json`. Lanza `Error('service-description.json de "<source>": <path>: <problema>')`.
 */
export function parseServiceDescription(raw: unknown, source: string): DeviceServiceDescription {
  try {
    return deepFreeze(parseDescription(raw));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`service-description.json de "${source}": ${msg}`);
  }
}
