import raw from './service-description.json';
import { parseServiceDescription } from '../../service-description';
import type { ConfigurationValues, DeviceModelDefinition } from '../../contract';

const RBW_MIN = 1000;
const RBW_MAX = 5_000_000;

/** Analizador de espectro Agilent E4402B (ESA-E): solo sensor. Validada al cargar el módulo. */
export const AGILENT_E4402B: DeviceModelDefinition = {
  description: parseServiceDescription(raw, 'agilent-e4402b'),

  validateConfiguration(effective: ConfigurationValues): string | null {
    const start = effective.defaultStartFreq;
    const stop = effective.defaultStopFreq;
    if (typeof start === 'number' && typeof stop === 'number' && start >= stop) {
      return '"Frecuencia inicial por defecto" debe ser menor que "Frecuencia final por defecto"';
    }
    const rbw = String(effective.resolutionBandwidth ?? 'AUTO');
    if (rbw !== 'AUTO') {
      const n = Number(rbw);
      if (!Number.isFinite(n) || n < RBW_MIN || n > RBW_MAX) return `El RBW debe ser AUTO o un valor entre ${RBW_MIN} y ${RBW_MAX} Hz`;
    }
    return null;
  },
};
