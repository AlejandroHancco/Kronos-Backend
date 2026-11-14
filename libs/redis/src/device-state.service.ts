import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaService, runningJobDeviceIds } from '@app/database';
import { REDIS_CLIENT } from './redis.constants';
import { RedisLockService } from './redis-lock.service';
import { deviceBusyMessage } from './device-busy';

const EXCLUSIVE_TTL_MS = 60_000;
const EXCLUSIVE_RENEW_MS = 20_000;

/**
 * Estado de ocupación de los dispositivos compartido entre procesos: una medición mantiene
 * `lock:device:<id>` (worker); un cambio de configuración toma el mismo lock en exclusiva.
 */
@Injectable()
export class DeviceStateService {
  private readonly logger = new Logger(DeviceStateService.name);
  /** Sobrescribibles en tests. */
  ttlMs = EXCLUSIVE_TTL_MS;
  renewEveryMs = EXCLUSIVE_RENEW_MS;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly locks: RedisLockService,
    private readonly prisma: PrismaService,
  ) {}

  /** Midiendo (lock Redis) o usado por un job programado con status 'running'. */
  async isBusy(deviceId: string): Promise<boolean> {
    if ((await this.redis.exists(`lock:device:${deviceId}`)) > 0) return true;
    return (await runningJobDeviceIds(this.prisma)).has(deviceId);
  }

  /** Ejecuta fn con el lock del dispositivo; 409 si ya está tomado (midiendo o configurándose). */
  async withExclusive<T>(device: { id: string; name: string }, fn: () => Promise<T>): Promise<T> {
    const key = `lock:device:${device.id}`;
    const token = await this.locks.tryAcquire(key, this.ttlMs);
    if (!token) {
      throw new ConflictException(deviceBusyMessage(device.name));
    }
    const timer = setInterval(() => {
      this.locks
        .renew(key, token, this.ttlMs)
        .then((ok) => {
          if (!ok) this.logger.warn(`Device lock ${key} lost before renewal`);
        })
        .catch((e: Error) => this.logger.warn(`Renew of ${key} failed: ${e.message}`));
    }, this.renewEveryMs);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
      await this.locks.release(key, token);
    }
  }
}
