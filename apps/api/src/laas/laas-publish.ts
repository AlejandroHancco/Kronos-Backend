import type {
  AcquisitionMetadata,
  AcquisitionSnapshot,
  ActuatorMetadata,
  DeviceServiceDescription,
  ExperimentDefinition,
  MeasurementValueMeta,
  SensorMetadata,
  SensorValueMetadata,
  StoredMeasurementPoint,
} from '@app/laas-catalog';
import { LAAS_PROTOCOL } from './laas-operations';
import { toLaasId } from './laas-ids';

/**
 * Funciones puras que convierten el catálogo (y filas de la base) en los documentos publicados por
 * /laas/v1: nombres de campo de las Tablas 14–20 de IEEE 1876, extensiones Kronos con `x-`.
 */

export interface LaasDeviceRef { id: string; name: string; deviceType: string; projectId: string; status: string }

/** Tabla 16 */
export interface LaasConfigurationElement {
  parameter: string;
  description: string;
  type: string;
  items?: string;
  'x-unit'?: string;
  'x-rangeMinimum'?: number;
  'x-rangeMaximum'?: number;
  'x-allowedValues'?: string[];
}

export type LaasSensorValue = Omit<SensorValueMetadata, 'label'> & { 'x-label'?: string };

/** Tabla 14 */
export interface LaasSensor {
  sensorId: string;
  fullName: string;
  description: string;
  protocol: string;
  produces: string;
  sensorValues: LaasSensorValue[];
  sensorConfiguration: LaasConfigurationElement[];
  accessMode: SensorMetadata['accessMode'];
  'x-deviceProtocol': string;
  'x-acquisition': AcquisitionMetadata;
  'x-device': LaasDeviceRef;
}

/** Tabla 19 */
export interface LaasActuator {
  actuatorId: string;
  fullName: string;
  description: string;
  protocol: string;
  inputType: string;
  actuatorValues: ActuatorMetadata['actuatorValues'];
  actuatorConfiguration: LaasConfigurationElement[];
  accessMode: ActuatorMetadata['accessMode'];
  'x-deviceProtocol': string;
  'x-device': LaasDeviceRef;
}

/** Tabla 20 */
export interface LaasExperiment {
  experimentId: string;
  fullName: string;
  description: string;
  sensors: string[];
  actuators: string[];
  'x-sensorType': string;
  'x-channelSelectorType': string | null;
  'x-channelRange': { min: number; max: number };
  'x-acquisition': AcquisitionMetadata;
  'x-simulated': boolean;
  'x-available'?: boolean;
}

export interface LaasSensorData {
  sensorId: string;
  measurementId: number;
  taskId: number;
  lastMeasured: string | null;
  acquisition: AcquisitionSnapshot;
  sensorValues: MeasurementValueMeta[];
  channels: { channel: number; points: { x?: number; values: Record<string, number> }[] }[];
}

export const deviceRefOf = (d: { id: string; name: string; type: string | null; projectId: string; status: string }): LaasDeviceRef =>
  ({ id: d.id, name: d.name, deviceType: d.type ?? '', projectId: d.projectId, status: d.status });

/**
 * sensorConfiguration (Tabla 16) derivada de la adquisición declarada: un barrido se configura con
 * start/stop (en la unidad de su variable), points y scale; una lectura puntual no tiene parámetros.
 */
export function sensorConfigurationOf(a: AcquisitionMetadata): LaasConfigurationElement[] {
  if (a.kind === 'single') return [];
  const v = a.variable;
  const bound = (which: string): LaasConfigurationElement => ({
    parameter: which,
    description: `${which === 'start' ? 'Inicio' : 'Fin'} del barrido de ${v.label} (${v.unit})`,
    type: 'double',
    'x-unit': v.unit,
    'x-rangeMinimum': v.rangeMinimum,
    'x-rangeMaximum': v.rangeMaximum,
  });
  return [
    bound('start'),
    bound('stop'),
    { parameter: 'points', description: 'Puntos del barrido', type: 'integer', 'x-rangeMinimum': a.points.minimum, 'x-rangeMaximum': a.points.maximum },
    { parameter: 'scale', description: 'Escala del barrido', type: 'string', 'x-allowedValues': [...a.scales] },
  ];
}

function sensorValueOf({ label, ...rest }: SensorValueMetadata, lastMeasured: string | undefined): LaasSensorValue {
  return { ...rest, ...(label !== undefined ? { 'x-label': label } : {}), ...(lastMeasured ? { lastMeasured } : {}) };
}

export function publishSensor(device: LaasDeviceRef, s: SensorMetadata, lastMeasured?: string): LaasSensor {
  return {
    sensorId: toLaasId(device.id, s.sensorId),
    fullName: s.fullName,
    description: s.description,
    protocol: LAAS_PROTOCOL,
    produces: s.produces,
    sensorValues: s.sensorValues.map((v) => sensorValueOf(v, lastMeasured)),
    sensorConfiguration: sensorConfigurationOf(s.acquisition),
    accessMode: { ...s.accessMode },
    'x-deviceProtocol': s.protocol,
    'x-acquisition': s.acquisition,
    'x-device': device,
  };
}

export function publishActuator(device: LaasDeviceRef, a: ActuatorMetadata): LaasActuator {
  return {
    actuatorId: toLaasId(device.id, a.actuatorId),
    fullName: a.fullName,
    description: a.description,
    protocol: LAAS_PROTOCOL,
    inputType: a.inputType,
    actuatorValues: a.actuatorValues.map((v) => ({ ...v })),
    // La configuración de Kronos es por dispositivo (getConfiguration), no por actuador.
    actuatorConfiguration: [],
    accessMode: { ...a.accessMode },
    'x-deviceProtocol': a.protocol,
    'x-device': device,
  };
}

/** Tabla 20. Sin instancias: ids del catálogo; con instancias: ids LaaS de cada dispositivo. */
export function publishExperiment(
  e: ExperimentDefinition,
  describe: (deviceType: string) => DeviceServiceDescription,
  instances?: { sensorDeviceIds: string[]; channelSelectorDeviceIds: string[]; available: boolean },
): LaasExperiment {
  const sensorModel = describe(e.sensorType);
  const selectorModel = e.channelSelectorType ? describe(e.channelSelectorType) : null;
  const sensorIds = sensorModel.sensors.map((s) => s.sensorId);
  const sensorActuatorIds = sensorModel.actuators.map((a) => a.actuatorId);
  const selectorActuatorIds = selectorModel?.actuators.map((a) => a.actuatorId) ?? [];
  const ids = (deviceIds: string[], catalogIds: string[]) => deviceIds.flatMap((d) => catalogIds.map((c) => toLaasId(d, c)));
  return {
    experimentId: e.experimentId,
    fullName: e.fullName,
    description: e.description,
    sensors: instances ? ids(instances.sensorDeviceIds, sensorIds) : sensorIds,
    actuators: instances
      ? [...ids(instances.sensorDeviceIds, sensorActuatorIds), ...ids(instances.channelSelectorDeviceIds, selectorActuatorIds)]
      : [...sensorActuatorIds, ...selectorActuatorIds],
    'x-sensorType': e.sensorType,
    'x-channelSelectorType': e.channelSelectorType,
    'x-channelRange': e.channelRange,
    'x-acquisition': e.acquisition,
    'x-simulated': e.simulated,
    ...(instances ? { 'x-available': instances.available } : {}),
  };
}

/** getSensorData: una medición almacenada (16 slots por sensorValue) → puntos por canal medido. */
export function sensorDataOf(
  sensorId: string,
  m: { id: number; taskId: number; takenAt: Date | null; acquisition: AcquisitionSnapshot; sensorValues: MeasurementValueMeta[]; points: StoredMeasurementPoint[]; channels: number[] },
): LaasSensorData {
  return {
    sensorId,
    measurementId: m.id,
    taskId: m.taskId,
    lastMeasured: m.takenAt ? m.takenAt.toISOString() : null,
    acquisition: m.acquisition,
    sensorValues: m.sensorValues,
    channels: m.channels.map((channel) => ({
      channel,
      points: m.points.map((p) => {
        const values = Object.fromEntries(Object.entries(p.values).map(([name, slots]) => [name, slots[channel - 1]]));
        return p.x === undefined ? { values } : { x: p.x, values };
      }),
    })),
  };
}
