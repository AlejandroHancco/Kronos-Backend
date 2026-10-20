import type { DeviceRole } from './device-plugin.registry';
import type { DeviceServiceDescription } from './device-plugin.interface';

export const CHANNEL_SLOTS = 16;
export interface MeasurementValueMeta { name: string; unit: string; label?: string }
export interface ChannelRange { min: number; max: number }
export interface ConfigDevice { id: string; name: string; type: string | null; projectId: string }

export function experimentConfigError(a: {
  taskProjectId: string; sensor: ConfigDevice; mux: ConfigDevice | null;
  sensorRole: DeviceRole | undefined; description: DeviceServiceDescription | undefined;
}): string | null {
  const { sensor, mux, description: d } = a;
  if (sensor.projectId !== a.taskProjectId) return 'El equipo de medición no pertenece al proyecto de la tarea';
  if (a.sensorRole !== 'sensor' || !d) return `El dispositivo "${sensor.name}" no es un equipo de medición registrado (tipo "${sensor.type}")`;
  if (valueMetasOf(d).length === 0) return `"${d.fullName}" no declara valores de sensor`;
  const cs = d.channelSelection;
  if (mux) {
    if (!cs) return `"${d.fullName}" no declara un selector de canal: no admite MUX`;
    if (mux.type !== cs.hostDeviceType) return `El MUX debe ser un dispositivo de tipo "${cs.hostDeviceType}"`;
    if (mux.projectId !== a.taskProjectId) return 'El MUX no pertenece al proyecto de la tarea';
  } else if (cs?.required) {
    return `"${d.fullName}" requiere un ${cs.hostLabel}`;
  }
  return null;
}

export function channelRangeFor(d: DeviceServiceDescription, hasMux: boolean): ChannelRange {
  if (!hasMux || !d.channelSelection) return { min: 1, max: 1 };
  const act = d.actuators.find((x) => x.actuatorId === d.channelSelection!.actuatorId);
  const ch = act?.actuatorValues.find((v) => v.name === 'channel');
  return {
    min: Math.max(1, ch?.rangeMinimum ?? 1),
    max: Math.min(CHANNEL_SLOTS, ch?.rangeMaximum ?? CHANNEL_SLOTS),
  };
}

export function invalidChannels(channels: number[], r: ChannelRange): number[] {
  return channels.filter((c) => !Number.isInteger(c) || c < r.min || c > r.max);
}

export function channelRangeMessage(r: ChannelRange, bad: number[]): string {
  if (r.min === 1 && r.max === 1) return 'Sin MUX solo se mide el canal 1';
  return `Canales fuera de rango para esta configuración (permitidos: ${r.min}–${r.max}): ${bad.join(', ')}`;
}

export function valueMetasOf(d: DeviceServiceDescription): MeasurementValueMeta[] {
  return d.sensors.flatMap((s) => s.sensorValues.map((v) => ({ name: v.name, unit: v.unit, ...(v.label ? { label: v.label } : {}) })));
}
