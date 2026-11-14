import { deviceIdsOf, PrefDevices } from '@app/database';

// deviceIdsOf / runningJobDeviceIds / PrefDevices viven en @app/database (los usa también @app/redis).
export { deviceIdsOf, runningJobDeviceIds } from '@app/database';
export type { PrefDevices } from '@app/database';

/** true si dos configuraciones comparten algún dispositivo físico (nunca por coincidir en "sin MUX"). */
export function sharesDevice(a: PrefDevices, b: PrefDevices): boolean {
  const ids = new Set(deviceIdsOf(a));
  return deviceIdsOf(b).some((id) => ids.has(id));
}
