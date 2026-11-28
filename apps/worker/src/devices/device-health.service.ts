import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { PrismaService } from '@app/database';
import { LaasCatalog } from '@app/laas-catalog';
import { RealtimePublisher } from '@app/realtime';
import { REDIS_CLIENT, RedisLockService } from '@app/redis';
import { DeviceReachability } from './device-reachability';
import { AlertDevice, DeviceAlerts } from './device-alerts';

const CHECK_INTERVAL_MS = 30_000;
const CONCURRENCY = 5;
/** TTL del liderazgo; no se libera al terminar (el TTL cierra el turno del intervalo). */
const LEADER_TTL_MS = 25_000;
/** Fallos consecutivos para dar por desconectado un dispositivo online (~1 min con chequeos cada 30 s). */
const FAILURES_TO_OFFLINE = 2;
/** El contador caduca si deja de chequearse (p. ej. dispositivo archivado), para no arrastrar fallos viejos. */
const FAIL_COUNTER_TTL_S = 3600;
/** La marca de caída caduca a los 30 días (una caída más larga ya no se avisa al recuperarse). */
const DOWN_MARKER_TTL_S = 30 * 24 * 3600;

/** Fallos consecutivos de chequeo del dispositivo. */
export const failKey = (deviceId: string) => `health:fail:${deviceId}`;
/** Inicio (ISO) de la caída en curso; existe solo mientras el dispositivo está desconectado tras haber estado online. */
export const downKey = (deviceId: string) => `health:down:${deviceId}`;

type CheckedDevice = AlertDevice & { ip: string | null; type: string | null; status: string };

/**
 * Chequea periódicamente si cada dispositivo está online según su driver, sin saturar la red
 * local ni el proceso: corre cada 30s solo en la réplica líder (lock Redis 'device-health'), con un
 * máximo de 5 chequeos en paralelo, y solo escribe en DB / emite por WebSocket cuando el estado
 * realmente cambia.
 *
 * Rebote: un dispositivo online pasa a offline solo tras 2 fallos seguidos (contador en Redis) y
 * vuelve a online con 1 éxito. En cada caída (online → offline) avisa una vez a los equipos del
 * proyecto y, al recuperarse, una vez más con la duración y los puntos perdidos (DeviceAlerts).
 * Un fallo al avisar se registra y nunca corta el ciclo.
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
    @Inject(REDIS_CLIENT) private redis: Redis,
    private alerts: DeviceAlerts,
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
      select: { id: true, name: true, ip: true, type: true, status: true, projectId: true },
    });

    for (let i = 0; i < devices.length; i += CONCURRENCY) {
      const batch = devices.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((device) => this.checkOne(device)));
    }
  }

  /**
   * Aislado por dispositivo: un error (p. ej. Redis del rebote caído) se registra y no corta el
   * lote. Las lecturas/escrituras de Redis van antes de cambiar el estado, así que un error de Redis
   * equivale a "sin información": el estado actual se mantiene.
   */
  private async checkOne(device: CheckedDevice) {
    try {
      const reachable = await this.reachability.check(device.type ?? '', device.ip);
      if (reachable) await this.onReachable(device);
      else await this.onUnreachable(device);
    } catch (err) {
      this.logger.error(
        `Chequeo de ${device.id} sin resultado (se mantiene ${device.status})`,
        err instanceof Error ? err.stack : err,
      );
    }
  }

  private async onReachable(device: CheckedDevice) {
    await this.redis.del(failKey(device.id));
    if (device.status === 'online') return;

    const downIso = await this.redis.get(downKey(device.id));
    await this.setStatus(device, 'online');
    if (!downIso) return; // no venía de una caída avisada (p. ej. dispositivo nuevo): nada que notificar
    await this.safely(`borrado de ${downKey(device.id)}`, () => this.redis.del(downKey(device.id)));
    await this.safely(`aviso de recuperación de ${device.id}`, () =>
      this.alerts.deviceOnline(alertDevice(device), new Date(downIso), new Date()),
    );
  }

  private async onUnreachable(device: CheckedDevice) {
    const failures = await this.countFailure(device.id);
    if (device.status === 'offline') return;
    if (device.status === 'online' && failures < FAILURES_TO_OFFLINE) return;

    // sin chequear → offline: nunca estuvo online, no es una caída (sin health:down ni aviso)
    const wasOnline = device.status === 'online';
    const at = new Date();
    // antes de tocar la BD: si Redis falla, el dispositivo sigue online y se reintenta en el próximo chequeo
    if (wasOnline) await this.redis.set(downKey(device.id), at.toISOString(), 'EX', DOWN_MARKER_TTL_S);
    await this.setStatus(device, 'offline');
    if (!wasOnline) return;
    await this.safely(`aviso de desconexión de ${device.id}`, () =>
      this.alerts.deviceOffline(alertDevice(device), at),
    );
  }

  /** INCR + EXPIRE del contador de fallos en una transacción; lanza si Redis falla. */
  private async countFailure(deviceId: string): Promise<number> {
    const results = await this.redis.multi().incr(failKey(deviceId)).expire(failKey(deviceId), FAIL_COUNTER_TTL_S).exec();
    const [incr] = results ?? [];
    if (!incr || incr[0]) throw incr?.[0] ?? new Error(`MULTI de ${failKey(deviceId)} abortado`);
    return Number(incr[1]);
  }

  private async setStatus(device: CheckedDevice, status: 'online' | 'offline') {
    await this.prisma.device.update({
      where: { id: device.id },
      data: { status },
    });

    // Aislado: un fallo al emitir (p. ej. error de DB al resolver equipos) no debe saltar el resto del lote.
    await this.safely(`device:status de ${device.id}`, () => this.realtime.deviceStatus(device.id, device.projectId, status));
  }

  private async safely(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`No se pudo emitir ${what}`, err instanceof Error ? err.stack : err);
    }
  }
}

function alertDevice(d: CheckedDevice): AlertDevice {
  return { id: d.id, name: d.name, projectId: d.projectId };
}
