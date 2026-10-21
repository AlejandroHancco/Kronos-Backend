import { Injectable } from '@nestjs/common';
import raw from './service-description.json';
import { parseServiceDescription } from '../../core/service-description';
import type {
  ConnectionTarget,
  DeviceContext,
  DeviceServiceDescription,
  MeasuredPoint,
  SensorPlugin,
} from '../../core/device-plugin.interface';
import { sweepXs, type AcquisitionRequest } from '../../core/acquisition';

/** Validada al cargar el módulo: una descripción inválida impide el arranque. */
const DESCRIPTION = parseServiceDescription(raw, 'sim-spectrum');

/** Hash FNV-1a de 32 bits → [0, 1): posiciones de picos estables por dispositivo. */
function unitHash(seed: string, salt: number): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  return (h >>> 0) / 0x100000000;
}

/** Amplitud (dBm) sin ruido: piso de -90 dBm y tres picos gaussianos en fracciones del rango que dependen de `seed`. */
export function spectrumAt(f: number, start: number, stop: number, seed: string): number {
  const span = stop - start || 1;
  let level = -90;
  for (let k = 0; k < 3; k++) {
    const center = start + span * (0.1 + 0.8 * unitHash(seed, k));
    const height = -30 - 30 * unitHash(seed, k + 10); // -30 … -60 dBm
    const width = span / 60;
    level = Math.max(level, height - 30 * ((f - center) / width) ** 2);
  }
  return level;
}

/**
 * Plugin SIMULADO: analizador de espectro sin hardware (demuestra la intercambiabilidad IEEE 1876).
 * Un solo sensor (amplitud en dBm), sin actuators; no requiere IP ni configuración.
 */
@Injectable()
export class SimulatedSpectrumPlugin implements SensorPlugin {
  static readonly DEVICE_TYPE = 'sim-spectrum';

  /** Uniforme en [-0.5, 0.5); el ruido es ±3 dB (·6). Reemplazable en tests. */
  randomUnit: () => number = () => Math.random() - 0.5;

  describe(): DeviceServiceDescription {
    return DESCRIPTION;
  }

  async testConnection(_target: ConnectionTarget): Promise<boolean> {
    return true;
  }

  async getSensorData(device: DeviceContext, request: AcquisitionRequest): Promise<MeasuredPoint[]> {
    if (request.kind !== 'sweep') throw new Error('El simulador de espectro solo hace barridos');
    return sweepXs(request.start, request.stop, request.points, request.scale).map((x) => ({
      x,
      values: { amplitude: spectrumAt(x, request.start, request.stop, device.id) + this.randomUnit() * 6 },
    }));
  }
}
