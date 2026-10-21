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
  SweepParams,
} from '../../core/device-plugin.interface';
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

  /** "getSensorData": envía el setup del barrido, consulta :MEASure? y lee la respuesta hasta \n. */
  getSensorData(device: DeviceContext, sweep: SweepParams): Promise<MeasuredPoint[]> {
    // Sin IP, net.createConnection usaría localhost: fallar antes con un mensaje claro.
    if (!device.ip) return Promise.reject(new Error(`El equipo "${device.name}" no tiene IP configurada`));
    const host = device.ip;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port: HIOKI_SCPI_PORT }, () => {
        socket.setTimeout(60000);

        (async () => {
          try {
            // 1. Comandos de setup sin esperar respuesta
            for (const cmd of sweepSetupCommands(sweep)) {
              socket.write(cmd + '\r\n');
              await new Promise((r) => setTimeout(r, 100));
            }

            // 2. :MEASure? y lectura byte a byte hasta \n (ignorando \r)
            socket.write(MEASURE_QUERY + '\r\n');

            const csvRaw = await new Promise<string>((res, rej) => {
              let response = '';
              let timeoutHandle: NodeJS.Timeout;

              const onData = (chunk: Buffer) => {
                for (const byte of chunk) {
                  const char = String.fromCharCode(byte);
                  if (char === '\n') {
                    clearTimeout(timeoutHandle);
                    socket.removeListener('data', onData);
                    res(response);
                    return;
                  }
                  if (char !== '\r') response += char;
                }
              };

              socket.on('data', onData);

              // Timeout de 55 segundos para esperar datos
              timeoutHandle = setTimeout(() => {
                socket.removeListener('data', onData);
                rej(new Error('Timeout waiting for measurement data'));
              }, 55000);
            });

            // 3. Loguear primeros y últimos 100 chars del CSV recibido
            const csvPreview =
              csvRaw.length <= 100
                ? csvRaw
                : `${csvRaw.substring(0, 100)} ... ${csvRaw.substring(csvRaw.length - 100)}`;
            this.logger.debug(`CSV Response (${csvRaw.length} chars): ${csvPreview}`);

            // 4. Tripletas [freq, g, b]
            socket.destroy();
            resolve(parseGbResponse(csvRaw));
          } catch (err) {
            socket.destroy();
            reject(err);
          }
        })();
      });

      socket.on('error', reject);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Analyzer connection timeout'));
      });
    });
  }
}
