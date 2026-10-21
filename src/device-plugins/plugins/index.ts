import type { Type } from '@nestjs/common';
import type { DevicePlugin } from '../core/device-plugin.interface';
import { HiokiIm3570Plugin } from './hioki-im3570/hioki-im3570.plugin';
import { KronosMux16Plugin } from './kronos-mux-16/kronos-mux-16.plugin';
import { SimulatedImpedancePlugin } from './sim-impedance/sim-impedance.plugin';

/** Única lista de plugins: agregar un modelo = una carpeta nueva + una línea aquí. */
export const DEVICE_PLUGINS: Type<DevicePlugin>[] = [HiokiIm3570Plugin, KronosMux16Plugin, SimulatedImpedancePlugin];
