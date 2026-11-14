import raw from './service-description.json';
import { parseServiceDescription } from '../../service-description';
import type { ConfigurationValues, DeviceModelDefinition } from '../../contract';

/** Analizador de impedancia Hioki IM3570: solo sensor. Validada al cargar el módulo. */
export const HIOKI_IM3570: DeviceModelDefinition = {
  description: parseServiceDescription(raw, 'hioki-im3570'),

  validateConfiguration(effective: ConfigurationValues): string | null {
    const start = effective.defaultStartFreq;
    const stop = effective.defaultStopFreq;
    if (typeof start === 'number' && typeof stop === 'number' && start >= stop) {
      return '"Frecuencia inicial por defecto" debe ser menor que "Frecuencia final por defecto"';
    }
    return null;
  },
};
