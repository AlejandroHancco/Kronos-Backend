import { Injectable, Logger } from '@nestjs/common';
import * as net from 'net';
import raw from './service-description.json';
import { parseServiceDescription } from '../../core/service-description';
import type {
  ConfigurationValues,
  ConnectionTarget,
  DeviceContext,
  DeviceServiceDescription,
  MeasuredPoint,
  SensorPlugin,
} from '../../core/device-plugin.interface';
import type { AcquisitionRequest } from '../../core/acquisition';
import type { ScpiTransport } from '../../core/transports/scpi-transport';
import { RawTcpScpi } from '../../core/transports/raw-tcp-scpi';
import { HIOKI_SCPI_PORT, MEASURE_QUERY, parseGbResponse, sweepSetupCommands } from './scpi';

/** Validada al cargar el módulo: una descripción inválida impide el arranque. */
const DESCRIPTION = parseServiceDescription(raw, 'hioki-im3570');

/**
 * Plugin del analizador de impedancia Hioki IM3570: solo sensor (SCPI sobre TCP, puerto 3570).
 * El MUX de canales es otro plugin (`kronos-mux-16`).
 */
@Injectable()
export class HiokiIm3570Plugin implements SensorPlugin {
  private readonly logger = new Logger(HiokiIm3570Plugin.name);

  static readonly DEVICE_TYPE = 'hioki-im3570';

  describe(): DeviceServiceDescription {
    return DESCRIPTION;
  }

  validateConfiguration(effective: ConfigurationValues): string | null {
    const start = effective.defaultStartFreq;
    const stop = effective.defaultStopFreq;
    if (typeof start === 'number' && typeof stop === 'number' && start >= stop) {
      return '"Frecuencia inicial por defecto" debe ser menor que "Frecuencia final por defecto"';
    }
    return null;
  }

  async testConnection({ ip, port = HIOKI_SCPI_PORT }: ConnectionTarget): Promise<boolean> {
    if (!ip) return false;
    return new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: ip, port });
      socket.setTimeout(2000);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /** Abre el transporte (reemplazable en tests). */
  openTransport(host: string): Promise<ScpiTransport> {
    return RawTcpScpi.open(host, HIOKI_SCPI_PORT, { terminator: '\r\n', writeDelayMs: 100, connectTimeoutMs: 5000 });
  }

  /** "getSensorData": setup del barrido, :MEASure? y lectura hasta \n (mismos comandos y tiempos que antes). */
  async getSensorData(device: DeviceContext, request: AcquisitionRequest): Promise<MeasuredPoint[]> {
    if (request.kind !== 'sweep') throw new Error('El Hioki IM3570 solo hace barridos');
    if (!device.ip) throw new Error(`El equipo "${device.name}" no tiene IP configurada`);
    const t = await this.openTransport(device.ip);
    try {
      for (const cmd of sweepSetupCommands(request)) await t.write(cmd);
      const csvRaw = await t.query(MEASURE_QUERY, 55_000);
      const preview = csvRaw.length <= 100 ? csvRaw : `${csvRaw.substring(0, 100)} ... ${csvRaw.substring(csvRaw.length - 100)}`;
      this.logger.debug(`CSV Response (${csvRaw.length} chars): ${preview}`);
      return parseGbResponse(csvRaw);
    } finally {
      t.close();
    }
  }
}
