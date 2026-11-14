import type { DeviceRole, DeviceServiceDescription } from './device-plugin.interface';

export const CHANNEL_SLOTS = 16;

/** `tipo "x"` para mensajes; los dispositivos sin tipo dicen "sin tipo" en vez de `tipo "null"`. */
export const typeLabel = (type: string | null | undefined) => (type ? `tipo "${type}"` : 'sin tipo');
export interface MeasurementValueMeta { name: string; unit: string; label?: string }
export interface ChannelRange { min: number; max: number }
export interface ConfigDevice { id: string; name: string; type: string | null; projectId: string }

/**
 * Reglas de una configuración de experimento: un equipo de medición (sensor) y, opcionalmente,
 * cualquier dispositivo selector de canal registrado. Devuelve el primer error o `null`.
 */
export function experimentConfigError(a: {
  taskProjectId: string;
  sensor: ConfigDevice;
  selector: ConfigDevice | null;
  sensorRole?: DeviceRole;
  selectorRole?: DeviceRole;
  sensorDescription?: DeviceServiceDescription;
}): string | null {
  const { sensor, selector, sensorDescription: d } = a;
  if (sensor.projectId !== a.taskProjectId) return 'El equipo de medición no pertenece al proyecto de la tarea';
  if (a.sensorRole !== 'sensor' || !d) {
    return `El dispositivo "${sensor.name}" no es un equipo de medición registrado (${typeLabel(sensor.type)})`;
  }
  if (valueMetasOf(d).length === 0) return `"${d.fullName}" no declara valores de sensor`;
  if (selector) {
    if (a.selectorRole !== 'channel-selector') {
      return `El dispositivo "${selector.name}" no es un selector de canal registrado (${typeLabel(selector.type)})`;
    }
    if (selector.projectId !== a.taskProjectId) return 'El selector de canal no pertenece al proyecto de la tarea';
  }
  return null;
}

/** Rango declarado por el `channelSelector` del dispositivo, acotado a [1, CHANNEL_SLOTS]; `null` si no declara uno. */
export function channelRangeOf(d: DeviceServiceDescription): ChannelRange | null {
  const cs = d.channelSelector;
  if (!cs) return null;
  const value = d.actuators
    .find((x) => x.actuatorId === cs.actuatorId)
    ?.actuatorValues.find((v) => v.name === cs.valueName);
  if (!value) return null;
  return {
    min: Math.max(1, value.rangeMinimum ?? 1),
    max: Math.min(CHANNEL_SLOTS, value.rangeMaximum ?? CHANNEL_SLOTS),
  };
}

/** Rango de canales de una configuración: el del selector, o solo el canal 1 sin selector. */
export function channelRangeFor(selector: DeviceServiceDescription | null): ChannelRange {
  return (selector && channelRangeOf(selector)) || { min: 1, max: 1 };
}

export function invalidChannels(channels: number[], r: ChannelRange): number[] {
  return channels.filter((c) => !Number.isInteger(c) || c < r.min || c > r.max);
}

export function channelRangeMessage(r: ChannelRange, bad: number[]): string {
  if (r.min === 1 && r.max === 1) return 'Sin selector de canal solo se mide el canal 1';
  return `Canales fuera de rango para esta configuración (permitidos: ${r.min}–${r.max}): ${bad.join(', ')}`;
}

export function valueMetasOf(d: DeviceServiceDescription): MeasurementValueMeta[] {
  return d.sensors.flatMap((s) => s.sensorValues.map((v) => ({ name: v.name, unit: v.unit, ...(v.label ? { label: v.label } : {}) })));
}
