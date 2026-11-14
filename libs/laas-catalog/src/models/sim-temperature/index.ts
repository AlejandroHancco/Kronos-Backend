import raw from './service-description.json';
import { parseServiceDescription } from '../../service-description';
import type { DeviceModelDefinition } from '../../contract';

/** Validada al cargar el módulo: una descripción inválida impide el arranque. */
export const SIM_TEMPERATURE: DeviceModelDefinition = {
  description: parseServiceDescription(raw, 'sim-temperature'),
};
