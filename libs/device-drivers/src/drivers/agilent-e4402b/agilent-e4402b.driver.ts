import { Injectable } from '@nestjs/common';
import * as net from 'net';
import {
  AGILENT_E4402B, acquisitionOf, sweepXs,
  type AcquisitionRequest, type ConfigurationValues, type ConnectionTarget, type DeviceContext, type MeasuredPoint,
  type SweepAcquisition,
} from '@app/laas-catalog';
import type { SensorDriver } from '../../device-driver';
import type { ScpiTransport } from '../../transports/scpi-transport';
import { RawTcpScpi } from '../../transports/raw-tcp-scpi';
import { PROLOGIX_PORT, PrologixScpi } from '../../transports/prologix-scpi';

const ACQUISITION = acquisitionOf(AGILENT_E4402B.description) as SweepAcquisition;
type SweepRequest = Extract<AcquisitionRequest, { kind: 'sweep' }>;

/** Comandos de setup de un barrido (ESA-E, SCPI). `:SWE:POIN` siempre: el panel puede tener otro valor aunque la declaración lo fije. */
export function e4402bSweepCommands(r: SweepRequest, cfg: ConfigurationValues): string[] {
  const rbw = String(cfg.resolutionBandwidth ?? 'AUTO');
  return [
    ':INIT:CONT OFF',
    `:FREQ:STAR ${r.start}`,
    `:FREQ:STOP ${r.stop}`,
    `:SWE:POIN ${r.points}`,
    rbw === 'AUTO' ? ':BAND:AUTO ON' : `:BAND ${rbw}`,
    `:DISP:WIND:TRAC:Y:RLEV ${Number(cfg.referenceLevel ?? 0)}`,
    ':FORM ASC',
  ];
}

export function parseTrace(rawTrace: string): number[] {
  return rawTrace.trim().split(',').map((v) => parseFloat(v.trim()));
}

/** Driver del analizador de espectro Agilent E4402B (ESA-E): solo sensor, detrás de un adaptador de red. */
@Injectable()
export class AgilentE4402bDriver implements SensorDriver {
  readonly deviceType = 'agilent-e4402b';

  async testConnection({ ip, port = PROLOGIX_PORT }: ConnectionTarget): Promise<boolean> {
    if (!ip) return false;
    return new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: ip, port });
      socket.setTimeout(2000);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
    });
  }

  /** Abre el transporte según la configuración del dispositivo (reemplazable en tests). */
  openTransport(device: DeviceContext, port: number): Promise<ScpiTransport> {
    return device.configuration.transport === 'raw'
      ? RawTcpScpi.open(device.ip!, port)
      : PrologixScpi.open(device.ip!, port, Number(device.configuration.gpibAddress ?? 18));
  }

  /** Espera de *OPC? sin el tiempo real del barrido: 3 × el barrido estimado por puntos, al menos 10 s. */
  opcTimeoutMs(points: number): number {
    return Math.max(10_000, Math.ceil(points * ACQUISITION.secondsPerPoint * 3 * 1000));
  }

  /**
   * Espera de *OPC? desde el tiempo de barrido que calcula el equipo (`:SWE:TIME?`, segundos; depende
   * del RBW y del span): max(10 s, 3 × barrido + 5 s). Si la consulta falla o no es un número finito,
   * cae a la estimación por puntos.
   */
  async sweepOpcTimeoutMs(t: ScpiTransport, points: number): Promise<number> {
    const seconds = parseFloat(await t.query(':SWE:TIME?', 5000).catch(() => ''));
    if (!Number.isFinite(seconds) || seconds < 0) return this.opcTimeoutMs(points);
    return Math.max(10_000, Math.ceil(3 * seconds * 1000 + 5000));
  }

  async getSensorData(device: DeviceContext, request: AcquisitionRequest): Promise<MeasuredPoint[]> {
    if (request.kind !== 'sweep') throw new Error('El Agilent E4402B solo hace barridos');
    if (!device.ip) throw new Error(`El equipo "${device.name}" no tiene IP configurada`);
    const t = await this.openTransport(device, PROLOGIX_PORT);
    try {
      for (const cmd of e4402bSweepCommands(request, device.configuration)) await t.write(cmd);
      await t.query(':INIT:IMM;*OPC?', await this.sweepOpcTimeoutMs(t, request.points));
      const amplitudes = parseTrace(await t.query(':TRAC? TRACE1'));
      if (amplitudes.length !== request.points || amplitudes.some((a) => !Number.isFinite(a))) {
        throw new Error(`El E4402B devolvió ${amplitudes.length} puntos; se esperaban ${request.points}`);
      }
      const xs = sweepXs(request.start, request.stop, request.points, 'LIN');
      return amplitudes.map((amplitude, i) => ({ x: xs[i], values: { amplitude } }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const deviceError = await t.query(':SYST:ERR?', 2000).catch(() => null);
      throw new Error(deviceError && !deviceError.startsWith('+0') ? `${message} (equipo: ${deviceError})` : message);
    } finally {
      t.close();
    }
  }
}
