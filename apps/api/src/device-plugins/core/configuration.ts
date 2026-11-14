import type {
  ConfigurationParameterMetadata,
  ConfigurationValue,
  ConfigurationValues,
  DeviceContext,
  DeviceServiceDescription,
} from './device-plugin.interface';

/**
 * Valida un valor contra la metadata de un parámetro de configuración.
 * Orden: tipo, allowedValues, rango, paso. Devuelve `null` si es válido.
 */
export function parameterValueError(p: ConfigurationParameterMetadata, value: unknown): string | null {
  switch (p.type) {
    case 'double':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `"${p.label}" debe ser un número`;
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return `"${p.label}" debe ser un número entero`;
      break;
    case 'string':
      if (typeof value !== 'string') return `"${p.label}" debe ser un texto`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `"${p.label}" debe ser verdadero o falso`;
      break;
  }

  if (p.allowedValues && !p.allowedValues.includes(value as string | number)) {
    return `"${p.label}" debe ser uno de: ${p.allowedValues.join(', ')}`;
  }

  const unitSuffix = p.unit ? ` ${p.unit}` : '';
  const v = value as number;
  if (
    (p.rangeMinimum !== undefined && v < p.rangeMinimum) ||
    (p.rangeMaximum !== undefined && v > p.rangeMaximum)
  ) {
    return `"${p.label}" debe estar entre ${p.rangeMinimum} y ${p.rangeMaximum}${unitSuffix}`;
  }

  if (p.rangeStep !== undefined) {
    const q = (v - (p.rangeMinimum ?? 0)) / p.rangeStep;
    if (Math.abs(q - Math.round(q)) >= 1e-9) {
      return `"${p.label}" debe avanzar en pasos de ${p.rangeStep}${unitSuffix}`;
    }
  }

  return null;
}

/**
 * Valores efectivos de un dispositivo: 'fixed' y 'persisted' toman el valor guardado si es
 * válido, o su `default`; los 'live' se omiten (se leen del dispositivo, no de aquí).
 */
export function effectiveConfiguration(params: ConfigurationParameterMetadata[], stored: unknown): ConfigurationValues {
  const storedObj = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const result: ConfigurationValues = {};
  for (const p of params) {
    if (p.storage === 'live') continue;
    const storedValue = storedObj[p.name];
    if (storedValue !== undefined && parameterValueError(p, storedValue) === null) {
      result[p.name] = storedValue as ConfigurationValue;
    } else if (p.default !== undefined) {
      result[p.name] = p.default;
    }
  }
  return result;
}

/** Errores en español por cada valor del patch: clave desconocida, solo lectura, o valor inválido. */
export function configurationPatchErrors(params: ConfigurationParameterMetadata[], patch: Record<string, unknown>): string[] {
  const keys = Object.keys(patch);
  if (keys.length === 0) return ['No hay valores para configurar'];

  const errors: string[] = [];
  for (const key of keys) {
    const p = params.find((pp) => pp.name === key);
    if (!p) {
      errors.push(`Parámetro de configuración desconocido: "${key}"`);
      continue;
    }
    if (p.access === 'read-only') {
      errors.push(`"${p.label}" es de solo lectura`);
      continue;
    }
    const err = parameterValueError(p, patch[key]);
    if (err) errors.push(err);
  }
  return errors;
}

/** Separa un patch ya validado en valores persistidos (DB) y live (dispositivo). */
export function splitPatch(
  params: ConfigurationParameterMetadata[],
  patch: ConfigurationValues,
): { persisted: ConfigurationValues; live: ConfigurationValues } {
  const persisted: ConfigurationValues = {};
  const live: ConfigurationValues = {};
  for (const [key, value] of Object.entries(patch)) {
    const p = params.find((pp) => pp.name === key);
    if (!p) continue;
    if (p.storage === 'live') live[key] = value;
    else if (p.storage === 'persisted') persisted[key] = value;
  }
  return { persisted, live };
}

/** Construye el `DeviceContext` que recibe un plugin a partir de la fila `devices` y su descripción. */
export function toDeviceContext(
  device: { id: string; name: string; ip: string | null; configuration?: unknown },
  description: DeviceServiceDescription,
): DeviceContext {
  return {
    id: device.id,
    name: device.name,
    ip: device.ip,
    configuration: effectiveConfiguration(description.configuration ?? [], device.configuration),
  };
}
