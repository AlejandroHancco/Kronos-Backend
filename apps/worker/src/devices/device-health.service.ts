import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '@app/database';
import { LaasCatalog } from '@app/laas-catalog';
import { RealtimePublisher } from '@app/realtime';
import { RedisLockService } from '@app/redis';
import { DeviceReachability } from './device-reachability';

const CHECK_INTERVAL_MS = 30_000;
const CONCURRENCY = 5;
/** TTL del liderazgo; no se libera al terminar (el TTL cierra el turno del intervalo). */
const LEADER_TTL_MS = 25_000;

/**
 * Chequea periódicamente si cada dispositivo está online según su driver, sin saturar la red
 * local ni el proceso: corre cada 30s solo en la réplica líder (lock Redis 'device-health'), con un
 * máximo de 5 chequeos en paralelo, y solo escribe en DB / emite por WebSocket cuando el estado
 * realmente cambia.
 */
@Injectable()
export class DeviceHealthService {
  private readonly logger = new Logger(DeviceHealthService.name);
  private ticking = false;

  constructor(
    private prisma: PrismaService,
    private catalog: LaasCatalog,
    private reachability: DeviceReachability,
    private realtime: RealtimePublisher,
    private lockService: RedisLockService,
  ) {}

  @Interval(CHECK_INTERVAL_MS)
  async checkAllDevices() {
    if (this.ticking) return;
    this.ticking = true;

    try {
      await this.lockService.runAsLeader('device-health', LEADER_TTL_MS, () => this.tick());
    } catch (err: any) {
      this.logger.warn(`Device health check failed: ${err.message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async tick(): Promise<void> {
    const addressless = this.catalog
      .catalog()
      .filter((e) => !e.connection.requiresIp)
      .map((e) => e.deviceType);
    const devices = await this.prisma.device.findMany({
      where: {
        status: { not: 'archived' },
        OR: [{ ip: { not: null } }, { type: { in: addressless } }],
      },
      select: { id: true, ip: true, type: true, status: true, projectId: true },
    });

    for (let i = 0; i < devices.length; i += CONCURRENCY) {
      const batch = devices.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((device) => this.checkOne(device)));
    }
  }

  private async checkOne(device: {
    id: string;
    ip: string | null;
    type: string | null;
    status: string;
    projectId: string;
  }) {
    const reachable = await this.reachability.check(device.type ?? '', device.ip);
    const newStatus = reachable ? 'online' : 'offline';

    if (newStatus === device.status) return;

    await this.prisma.device.update({
      where: { id: device.id },
      data: { status: newStatus },
    });

    // Aislado: un fallo al emitir (p. ej. error de DB al resolver equipos) no debe saltar el resto del lote.
    try {
      await this.realtime.deviceStatus(device.id, device.projectId, newStatus);
    } catch (err) {
      this.logger.error(
        `No se pudo emitir device:status de ${device.id}`,
        err instanceof Error ? err.stack : err,
      );
    }
  }
}
