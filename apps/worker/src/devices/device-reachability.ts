import { Injectable, Logger } from '@nestjs/common';
import { LaasCatalog } from '@app/laas-catalog';
import { DeviceDriverRegistry } from '@app/device-drivers';

/**
 * Chequeo crudo de alcanzabilidad vía el driver registrado para `type`. Lo usan el health check
 * periódico y la operación `test-connection` de la cola device-ops. Nunca lanza: tipo desconocido,
 * IP requerida ausente o error del driver → `false`.
 */
@Injectable()
export class DeviceReachability {
  private readonly logger = new Logger(DeviceReachability.name);

  constructor(
    private readonly catalog: LaasCatalog,
    private readonly drivers: DeviceDriverRegistry,
  ) {}

  /** Sin `port` usa el `connection.defaultPort` del catálogo (o ninguno). */
  async check(type: string, ip: string | null, port?: number): Promise<boolean> {
    if (!this.catalog.has(type) || !this.drivers.has(type)) return false;
    const { connection } = this.catalog.describe(type);
    if (connection.requiresIp && !ip) return false;
    try {
      return (await this.drivers.get(type).testConnection({ ip, port: port ?? connection.defaultPort })) === true;
    } catch (err) {
      this.logger.warn(`testConnection de "${type}" falló: ${(err as Error).message}`);
      return false;
    }
  }
}
