import type { Type } from '@nestjs/common';
import type { DeviceDriver } from '../device-driver';
import { HiokiIm3570Driver } from './hioki-im3570/hioki-im3570.driver';
import { AgilentE4402bDriver } from './agilent-e4402b/agilent-e4402b.driver';
import { KronosMux16Driver } from './kronos-mux-16/kronos-mux-16.driver';
import { SimulatedImpedanceDriver } from './sim-impedance/sim-impedance.driver';
import { SimulatedSpectrumDriver } from './sim-spectrum/sim-spectrum.driver';
import { SimulatedTemperatureDriver } from './sim-temperature/sim-temperature.driver';

export {
  HiokiIm3570Driver, AgilentE4402bDriver, KronosMux16Driver,
  SimulatedImpedanceDriver, SimulatedSpectrumDriver, SimulatedTemperatureDriver,
};

/**
 * Única lista de drivers: agregar un modelo = una carpeta `drivers/<modelo>/` + una línea aquí,
 * y su descripción en `@app/laas-catalog` (`DeviceDriverRegistry.assertParity` comprueba ambas listas).
 */
export const DEVICE_DRIVERS: Type<DeviceDriver>[] = [
  HiokiIm3570Driver,
  AgilentE4402bDriver,
  KronosMux16Driver,
  SimulatedImpedanceDriver,
  SimulatedSpectrumDriver,
  SimulatedTemperatureDriver,
];
