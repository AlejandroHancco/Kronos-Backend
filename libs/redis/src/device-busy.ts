/**
 * Texto del 409 "dispositivo ocupado" (midiendo o configurándose). Único origen: lo lanza
 * DeviceStateService.withExclusive (API y worker) y la API lo reconoce en el failedReason de un
 * job de device-ops fallido (ver mapDeviceOpError en apps/api).
 */
export const DEVICE_BUSY_MARKER = 'está midiendo; espera a que termine para cambiar su configuración';

export const deviceBusyMessage = (name: string): string => `"${name}" ${DEVICE_BUSY_MARKER}`;
