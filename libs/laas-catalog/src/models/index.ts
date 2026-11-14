import type { DeviceModelDefinition } from '../contract';
import { HIOKI_IM3570 } from './hioki-im3570';
import { AGILENT_E4402B } from './agilent-e4402b';
import { KRONOS_MUX_16 } from './kronos-mux-16';
import { SIM_IMPEDANCE } from './sim-impedance';
import { SIM_SPECTRUM } from './sim-spectrum';
import { SIM_TEMPERATURE } from './sim-temperature';

export { HIOKI_IM3570, AGILENT_E4402B, KRONOS_MUX_16, SIM_IMPEDANCE, SIM_SPECTRUM, SIM_TEMPERATURE };

/**
 * Única lista de modelos del catálogo: agregar un modelo = una carpeta `models/<modelo>/`
 * (service-description.json + index.ts) + una línea aquí, y su driver en `@app/device-drivers`.
 */
export const DEVICE_MODELS: DeviceModelDefinition[] = [
  HIOKI_IM3570,
  AGILENT_E4402B,
  KRONOS_MUX_16,
  SIM_IMPEDANCE,
  SIM_SPECTRUM,
  SIM_TEMPERATURE,
];
