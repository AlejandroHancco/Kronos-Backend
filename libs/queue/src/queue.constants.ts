export const MEASUREMENTS_QUEUE = 'measurements';
/** Puntos de series programadas: cola propia para que los manuales nunca ocupen su turno. */
export const SCHEDULED_MEASUREMENTS_QUEUE = 'scheduled-measurements';
export const DEVICE_OPS_QUEUE = 'device-ops';

// Prioridades Bull (menor = más prioritario): los jobs programados van primero
export const PRIORITY_SCHEDULED = 1;
export const PRIORITY_MANUAL = 10;
