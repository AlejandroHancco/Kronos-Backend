import raw from './service-description.json';
import { parseServiceDescription } from '../../service-description';
import type { DeviceModelDefinition } from '../../contract';

/** Validada al cargar el módulo: una descripción inválida impide el arranque. */
export const KRONOS_MUX_16: DeviceModelDefinition = {
  description: parseServiceDescription(raw, 'kronos-mux-16'),
};
