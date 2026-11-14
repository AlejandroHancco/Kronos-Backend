import type { ActuatorMetadata } from './contract';

/**
 * Validación de seguridad de setActuatorData (IEEE 1876 §4.4.1: validar los valores antes de
 * aplicarlos al equipo): cada valor debe estar declarado por el actuator, ser numérico y respetar
 * rangeMinimum / rangeMaximum / rangeStep. La aplica el worker; la API reconoce estos mensajes en
 * el failedReason del job (isActuatorValueError) para responder 400.
 */
export function actuatorValuesError(actuator: ActuatorMetadata, values: Record<string, unknown>): string | null {
  for (const [name, value] of Object.entries(values)) {
    const meta = actuator.actuatorValues.find((v) => v.name === name);
    if (!meta) return `"${name}" no es un valor del actuator "${actuator.actuatorId}"`;
    const { rangeMinimum: min, rangeMaximum: max, rangeStep: step } = meta;
    const outOfRange = typeof value !== 'number' || !Number.isFinite(value) ||
      (min !== undefined && value < min) || (max !== undefined && value > max);
    if (outOfRange) {
      const bounds = min !== undefined && max !== undefined ? `debe estar entre ${min} y ${max}`
        : min !== undefined ? `debe ser ≥ ${min}`
        : max !== undefined ? `debe ser ≤ ${max}`
        : 'debe ser un número';
      return `"${name}" ${bounds}`;
    }
    if (step !== undefined && step > 0) {
      const k = (value - (min ?? 0)) / step;
      if (Math.abs(k - Math.round(k)) > 1e-9) {
        return `"${name}" debe avanzar en pasos de ${step}${min !== undefined ? ` desde ${min}` : ''}`;
      }
    }
  }
  return null;
}

export const actuatorMissingMessage = (deviceName: string, actuatorId: string): string =>
  `"${deviceName}" no tiene el actuator "${actuatorId}"`;

const ACTUATOR_VALUE_ERRORS = [
  /^"[^"]*" debe (estar entre|ser ≥|ser ≤|ser un número|avanzar en pasos de)/,
  /^"[^"]*" no es un valor del actuator "/,
  /^"[^"]*" no tiene el actuator "/,
];

/** ¿Es `message` uno de los rechazos de actuatorValuesError / actuatorMissingMessage? */
export const isActuatorValueError = (message: string): boolean => ACTUATOR_VALUE_ERRORS.some((p) => p.test(message));
