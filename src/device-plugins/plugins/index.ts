import type { Type } from '@nestjs/common';
import type { DeviceDriverPlugin } from '../core/device-plugin.interface';
import { HiokiIm3570Plugin } from './hioki-im3570/hioki-im3570.plugin';
import { SimulatedImpedancePlugin } from './sim-impedance/sim-impedance.plugin';

/** Única lista de plugins: agregar un modelo = una carpeta nueva + una línea aquí. */
export const DEVICE_PLUGINS: Type<DeviceDriverPlugin>[] = [HiokiIm3570Plugin, SimulatedImpedancePlugin];
