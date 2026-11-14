import { Injectable, Logger } from '@nestjs/common';
import * as net from 'net';
import type { AcquisitionRequest, ConnectionTarget, DeviceContext, MeasuredPoint } from '@app/laas-catalog';
import type { SensorDriver } from '../../device-driver';
import type { ScpiTransport } from '../../transports/scpi-transport';
import { RawTcpScpi } from '../../transports/raw-tcp-scpi';
import { HIOKI_SCPI_PORT, MEASURE_QUERY, parseGbResponse, sweepSetupCommands } from './scpi';

/**
 * Driver del analizador de impedancia Hioki IM3570: solo sensor (SCPI sobre TCP, puerto 3570).
 * El MUX de canales es otro modelo (`kronos-mux-16`). Descripción en `@app/laas-catalog`.
 */
@Injectable()
export class HiokiIm3570Driver implements SensorDriver {
  private readonly logger = new Logger(HiokiIm3570Driver.name);

  readonly deviceType = 'hioki-im3570';

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

  /** Abre el transporte (reemplazable en tests); un fallo de conexión se informa en español. */
  async openTransport(host: string): Promise<ScpiTransport> {
    try {
      return await RawTcpScpi.open(host, HIOKI_SCPI_PORT, { terminator: '\r\n', writeDelayMs: 100, connectTimeoutMs: 5000 });
    } catch {
      throw new Error(`Sin respuesta del Hioki IM3570 en ${host}:${HIOKI_SCPI_PORT}`);
    }
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
