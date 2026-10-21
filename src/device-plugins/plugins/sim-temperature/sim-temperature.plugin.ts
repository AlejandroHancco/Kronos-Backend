import { Injectable } from '@nestjs/common';
import raw from './service-description.json';
import { parseServiceDescription } from '../../core/service-description';
import type { AcquisitionRequest } from '../../core/acquisition';
import type { ConnectionTarget, DeviceContext, DeviceServiceDescription, MeasuredPoint, SensorPlugin } from '../../core/device-plugin.interface';

const DESCRIPTION = parseServiceDescription(raw, 'sim-temperature');

/** Ciclo diario: `atMin` a las 3 h y `atMax` a las 15 h (coseno). Para la humedad se invierten los extremos. */
export function dailyCurve(hour: number, atMin: number, atMax: number): number {
  const mid = (atMin + atMax) / 2;
  const amp = (atMax - atMin) / 2;
  return mid - amp * Math.cos((2 * Math.PI * (hour - 3)) / 24);
}

/** Plugin SIMULADO de lectura puntual (kind "single"): demuestra un sensor que no barre. */
@Injectable()
export class SimulatedTemperaturePlugin implements SensorPlugin {
  static readonly DEVICE_TYPE = 'sim-temperature';

  /** Uniforme en [-0.5, 0.5); reemplazable en tests. */
  randomUnit: () => number = () => Math.random() - 0.5;
  now: () => Date = () => new Date();

  describe(): DeviceServiceDescription {
    return DESCRIPTION;
  }

  async testConnection(_target: ConnectionTarget): Promise<boolean> {
    return true;
  }

  async getSensorData(_device: DeviceContext, request: AcquisitionRequest): Promise<MeasuredPoint[]> {
    if (request.kind !== 'single') throw new Error('El sensor de temperatura simulado solo hace lecturas puntuales');
    const d = this.now();
    const hour = d.getHours() + d.getMinutes() / 60;
    return [{
      values: {
        temperature: dailyCurve(hour, 18, 28) + this.randomUnit() * 0.4,
        humidity: dailyCurve(hour, 90, 60) + this.randomUnit() * 2,
      },
    }];
  }
}
