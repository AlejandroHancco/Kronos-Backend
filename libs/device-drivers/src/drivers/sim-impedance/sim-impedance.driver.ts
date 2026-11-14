import { Injectable } from '@nestjs/common';
import {
  sweepXs, type AcquisitionRequest, type ConfigurationValues, type ConnectionTarget, type DeviceContext, type MeasuredPoint,
} from '@app/laas-catalog';
import type { SensorDriver } from '../../device-driver';


/** Circuito de Randles simplificado: Rs + (Rp ‖ C). Valores típicos de un concreto en fraguado. */
export interface RandlesParams { rs: number; rp: number; c: number }
export const CONCRETE_LIKE: RandlesParams = { rs: 150, rp: 20_000, c: 2e-9 };

/** |Z| (Ω) del modelo a la frecuencia f (Hz). */
export function randlesImpedance(f: number, p: RandlesParams = CONCRETE_LIKE): number {
  const wRC = 2 * Math.PI * f * p.rp * p.c;
  const denom = 1 + wRC * wRC;
  return Math.hypot(p.rs + p.rp / denom, (p.rp * wRC) / denom);
}

/** Parámetros del modelo desde la configuración efectiva del dispositivo (`c` se configura en nF). */
export function randlesParamsOf(cfg: ConfigurationValues): RandlesParams {
  return { rs: Number(cfg.rs), rp: Number(cfg.rp), c: Number(cfg.c) * 1e-9 };
}

/**
 * Driver SIMULADO: demuestra la intercambiabilidad de dispositivos (IEEE 1876) sin hardware.
 * Un solo sensor (|Z| en Ω), sin actuators; el modelo y el ruido salen de la configuración del dispositivo.
 */
@Injectable()
export class SimulatedImpedanceDriver implements SensorDriver {
  readonly deviceType = 'sim-impedance';

  /** Uniforme en [-0.5, 0.5); el ruido es z·(1 + 2·randomUnit()·noisePercent/100). Reemplazable en tests. */
  randomUnit: () => number = () => Math.random() - 0.5;

  async testConnection(_target: ConnectionTarget): Promise<boolean> {
    return true;
  }

  async getSensorData(device: DeviceContext, request: AcquisitionRequest): Promise<MeasuredPoint[]> {
    if (request.kind !== 'sweep') throw new Error('El simulador de impedancia solo hace barridos');
    const params = randlesParamsOf(device.configuration);
    const noisePercent = Number(device.configuration.noisePercent ?? 0);
    return sweepXs(request.start, request.stop, request.points, request.scale).map((x) => ({
      x,
      values: { z: randlesImpedance(x, params) * (1 + (2 * this.randomUnit() * noisePercent) / 100) },
    }));
  }
}
