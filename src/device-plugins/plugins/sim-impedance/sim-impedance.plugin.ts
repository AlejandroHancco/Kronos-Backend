import { Injectable } from '@nestjs/common';
import { DeviceDriverPlugin, DeviceServiceDescription, MeasureChannelParams, MeasuredPoint } from '../../core/device-plugin.interface';

/** Circuito de Randles simplificado: Rs + (Rp ‖ C). Valores típicos de un concreto en fraguado. */
export interface RandlesParams { rs: number; rp: number; c: number }
export const CONCRETE_LIKE: RandlesParams = { rs: 150, rp: 20_000, c: 2e-9 };

/** |Z| (Ω) del modelo a la frecuencia f (Hz). */
export function randlesImpedance(f: number, p: RandlesParams = CONCRETE_LIKE): number {
  const wRC = 2 * Math.PI * f * p.rp * p.c;
  const denom = 1 + wRC * wRC;
  return Math.hypot(p.rs + p.rp / denom, (p.rp * wRC) / denom);
}

export function sweepFrequencies(start: number, stop: number, points: number, sweepType: string): number[] {
  if (points <= 1) return [start];
  return Array.from({ length: points }, (_, i) => {
    const t = i / (points - 1);
    return sweepType === 'LOG' && start > 0 ? start * (stop / start) ** t : start + (stop - start) * t;
  });
}

/**
 * Plugin SIMULADO: demuestra la intercambiabilidad de dispositivos (IEEE 1876) sin hardware.
 * Un solo sensor (|Z| en Ω), sin actuators ni MUX: mide un único canal lógico (canal 1).
 */
@Injectable()
export class SimulatedImpedancePlugin implements DeviceDriverPlugin {
  static readonly DEVICE_TYPE = 'sim-impedance';

  /** Ruido multiplicativo uniforme ±0.5 %; reemplazable en tests. */
  noise: () => number = () => (Math.random() - 0.5) * 0.01;

  describe(): DeviceServiceDescription {
    return {
      deviceType: SimulatedImpedancePlugin.DEVICE_TYPE,
      fullName: 'Impedancímetro simulado (Randles)',
      manufacturer: 'Kronos (simulación)',
      description: 'SIMULADO: genera |Z|(f) de un modelo Rs + (Rp ‖ C) con ruido; no requiere hardware ni MUX',
      simulated: true,
      connection: { requiresIp: false },
      sensors: [{
        sensorId: 'sim-impedance-z',
        fullName: 'Módulo de impedancia simulado',
        description: 'Módulo de la impedancia |Z| por frecuencia (simulado)',
        protocol: 'simulated',
        produces: 'application/json',
        sensorValues: [{ name: 'z', unit: 'Ω', type: 'double', label: 'Módulo de impedancia |Z|', rangeMinimum: 0, rangeMaximum: 1e6 }],
        accessMode: { accessModeType: 'pull' },
      }],
      actuators: [],
    };
  }

  async testConnection(_ip: string, _deviceType: string, _port?: number): Promise<boolean> {
    return true;
  }

  async measureChannel(params: MeasureChannelParams): Promise<MeasuredPoint[]> {
    return sweepFrequencies(params.startFreq, params.stopFreq, params.points, params.sweepType).map((frequency) => ({
      frequency,
      values: { z: randlesImpedance(frequency) * (1 + this.noise()) },
    }));
  }
}
