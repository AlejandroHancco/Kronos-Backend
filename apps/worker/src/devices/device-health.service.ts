import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '@app/database';
import { DevicePluginRegistry } from '@app/device-plugins';
import { RealtimePublisher } from '@app/realtime';
import { RedisLockService } from '@app/redis';

const CHECK_INTERVAL_MS = 30_000;
const CONCURRENCY = 5;
/** TTL del liderazgo; no se libera al terminar (el TTL cierra el turno del intervalo). */
const LEADER_TTL_MS = 25_000;

/**
 * Chequea periódicamente si cada dispositivo (analyzer/mux) está online, sin saturar
 * la red local ni el proceso: corre cada 30s (solo en la réplica líder, lock Redis
 * 'device-health'), con un máximo de 5 chequeos en paralelo, y solo escribe en DB /
 * emite por WebSocket cuando el estado realmente cambia.
 */
@Injectable()
export class DeviceHealthService {
  private readonly logger = new Logger(DeviceHealthService.name);
  private ticking = false;

  constructor(
    private prisma: PrismaService,
    private devicePlugins: DevicePluginRegistry,
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

  /**
   * Chequeo crudo de alcanzabilidad. Delega en el plugin registrado para `type` — un
   * dispositivo nuevo (type distinto) queda cubierto con solo registrar su plugin.
   */
  async checkReachable(type: string, ip: string, port = 3570): Promise<boolean> {
    if (!this.devicePlugins.has(type)) return false;
    return this.devicePlugins.get(type).testConnection(ip, type, port);
  }

  private async tick(): Promise<void> {
    const devices = await this.prisma.device.findMany({
      where: { ip: { not: null }, status: { not: 'archived' } },
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
    if (!device.ip) return;

    const reachable = await this.checkReachable(device.type ?? 'analyzer', device.ip);
    const newStatus = reachable ? 'online' : 'offline';

    if (newStatus === device.status) return;

    await this.prisma.device.update({
      where: { id: device.id },
      data: { status: newStatus },
    });

    this.realtime.deviceStatus(device.id, device.projectId, newStatus);
  }
}
