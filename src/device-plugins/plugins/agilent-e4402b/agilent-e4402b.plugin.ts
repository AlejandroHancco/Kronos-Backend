import { Injectable } from '@nestjs/common';
import * as net from 'net';
import raw from './service-description.json';
import { parseServiceDescription } from '../../core/service-description';
import { acquisitionOf, sweepXs, type AcquisitionRequest, type SweepAcquisition } from '../../core/acquisition';
import type {
  ConfigurationValues, ConnectionTarget, DeviceContext, DeviceServiceDescription, MeasuredPoint, SensorPlugin,
} from '../../core/device-plugin.interface';
import type { ScpiTransport } from '../../core/transports/scpi-transport';
import { RawTcpScpi } from '../../core/transports/raw-tcp-scpi';
import { PROLOGIX_PORT, PrologixScpi } from '../../core/transports/prologix-scpi';

const DESCRIPTION = parseServiceDescription(raw, 'agilent-e4402b');
const ACQUISITION = acquisitionOf(DESCRIPTION) as SweepAcquisition;
type SweepRequest = Extract<AcquisitionRequest, { kind: 'sweep' }>;

const RBW_MIN = 1000;
const RBW_MAX = 5_000_000;

/** Comandos de setup de un barrido (ESA-E, SCPI). Puntos: solo si la declaración permite variarlos. */
export function e4402bSweepCommands(r: SweepRequest, cfg: ConfigurationValues): string[] {
  const rbw = String(cfg.resolutionBandwidth ?? 'AUTO');
  return [
    ':INIT:CONT OFF',
    `:FREQ:STAR ${r.start}`,
    `:FREQ:STOP ${r.stop}`,
    ...(ACQUISITION.points.minimum !== ACQUISITION.points.maximum ? [`:SWE:POIN ${r.points}`] : []),
    rbw === 'AUTO' ? ':BAND:AUTO ON' : `:BAND ${rbw}`,
    `:DISP:WIND:TRAC:Y:RLEV ${Number(cfg.referenceLevel ?? 0)}`,
    ':FORM ASC',
  ];
}

export function parseTrace(rawTrace: string): number[] {
  return rawTrace.trim().split(',').map((v) => parseFloat(v.trim()));
}

/** Plugin del analizador de espectro Agilent E4402B (ESA-E): solo sensor, detrás de un adaptador de red. */
@Injectable()
export class AgilentE4402bPlugin implements SensorPlugin {
  static readonly DEVICE_TYPE = 'agilent-e4402b';

  describe(): DeviceServiceDescription {
    return DESCRIPTION;
  }

  validateConfiguration(effective: ConfigurationValues): string | null {
    const start = effective.defaultStartFreq;
    const stop = effective.defaultStopFreq;
    if (typeof start === 'number' && typeof stop === 'number' && start >= stop) {
      return '"Frecuencia inicial por defecto" debe ser menor que "Frecuencia final por defecto"';
    }
    const rbw = String(effective.resolutionBandwidth ?? 'AUTO');
    if (rbw !== 'AUTO') {
      const n = Number(rbw);
      if (!Number.isFinite(n) || n < RBW_MIN || n > RBW_MAX) return `El RBW debe ser AUTO o un valor entre ${RBW_MIN} y ${RBW_MAX} Hz`;
    }
    return null;
  }

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

  /** Espera de *OPC?: 3 × el barrido estimado, al menos 10 s. */
  opcTimeoutMs(points: number): number {
    return Math.max(10_000, Math.ceil(points * ACQUISITION.secondsPerPoint * 3 * 1000));
  }

  async getSensorData(device: DeviceContext, request: AcquisitionRequest): Promise<MeasuredPoint[]> {
    if (request.kind !== 'sweep') throw new Error('El Agilent E4402B solo hace barridos');
    if (!device.ip) throw new Error(`El equipo "${device.name}" no tiene IP configurada`);
    const t = await this.openTransport(device, PROLOGIX_PORT);
    try {
      for (const cmd of e4402bSweepCommands(request, device.configuration)) await t.write(cmd);
      await t.query(':INIT:IMM;*OPC?', this.opcTimeoutMs(request.points));
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
