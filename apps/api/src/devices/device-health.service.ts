import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { DevicesService } from './devices.service';
import { KronosGateway } from '../gateway/kronos.gateway';

const CHECK_INTERVAL_MS = 30_000;
const CONCURRENCY = 5;

/**
 * Chequea periódicamente si cada dispositivo según su plugin está online, sin saturar
 * la red local ni el proceso: corre cada 30s, con un máximo de 5 chequeos en paralelo,
 * y solo escribe en DB / emite por WebSocket cuando el estado realmente cambia.
 */
@Injectable()
export class DeviceHealthService {
  private readonly logger = new Logger(DeviceHealthService.name);
  private ticking = false;

  constructor(
    private prisma: PrismaService,
    private devicesService: DevicesService,
    private kronosGateway: KronosGateway,
  ) {}

  @Interval(CHECK_INTERVAL_MS)
  async checkAllDevices() {
    if (this.ticking) return;
    this.ticking = true;

    try {
      const devices = await this.prisma.device.findMany({
        where: {
          status: { not: 'archived' },
          OR: [{ ip: { not: null } }, { type: { in: this.devicesService.addresslessTypes() } }],
        },
        select: { id: true, ip: true, type: true, status: true, projectId: true },
      });

      for (let i = 0; i < devices.length; i += CONCURRENCY) {
        const batch = devices.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map((device) => this.checkOne(device)));
      }
    } catch (err: any) {
      this.logger.warn(`Device health check failed: ${err.message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async checkOne(device: {
    id: string;
    ip: string | null;
    type: string | null;
    status: string;
    projectId: string;
  }) {
    const reachable = await this.devicesService.checkReachable(device.type ?? '', device.ip);
    const newStatus = reachable ? 'online' : 'offline';

    if (newStatus === device.status) return;

    await this.prisma.device.update({
      where: { id: device.id },
      data: { status: newStatus },
    });

    // Aislado: un fallo al emitir (p. ej. error de DB al resolver equipos) no debe saltar el resto del lote.
    try {
      await this.kronosGateway.emitDeviceStatusChanged(device.id, device.projectId, newStatus);
    } catch (err) {
      this.logger.error(
        `No se pudo emitir device:status de ${device.id}`,
        err instanceof Error ? err.stack : err,
      );
    }
  }
}
