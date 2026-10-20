/** Dispositivos que ocupa una configuración de tarea; el MUX es opcional (null = sin MUX). */
export interface PrefDevices { analyzerDeviceId: string; muxDeviceId: string | null }

export function deviceIdsOf(p: PrefDevices): string[] {
  return p.muxDeviceId ? [p.analyzerDeviceId, p.muxDeviceId] : [p.analyzerDeviceId];
}

/** true si dos configuraciones comparten algún dispositivo físico (nunca por coincidir en "sin MUX"). */
export function sharesDevice(a: PrefDevices, b: PrefDevices): boolean {
  const ids = new Set(deviceIdsOf(a));
  return deviceIdsOf(b).some((id) => ids.has(id));
}
