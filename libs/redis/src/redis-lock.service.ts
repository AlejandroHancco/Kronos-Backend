import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

const MAX_BACKOFF_MS = 10_000;

export class DeviceBusyTimeoutError extends Error {
  constructor(public readonly deviceIds: string[], waitedMs: number) {
    super(`Devices busy after waiting ${waitedMs} ms: ${deviceIds.join(', ')}`);
    this.name = 'DeviceBusyTimeoutError';
  }
}

export interface DeviceLockOptions {
  ttlMs?: number;
  renewEveryMs?: number;
  waitTimeoutMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Locks distribuidos sobre Redis: exclusividad de dispositivos y elección de líder.
 */
@Injectable()
export class RedisLockService {
  private readonly logger = new Logger(RedisLockService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async tryAcquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const res = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return res === 'OK' ? token : null;
  }

  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    const res = await this.redis.eval(RENEW_SCRIPT, 1, key, token, String(ttlMs));
    return Number(res) === 1;
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
  }

  /** Ejecuta fn solo si se obtiene el liderazgo; no libera (el TTL termina el turno). */
  async runAsLeader(name: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean> {
    const token = await this.tryAcquire(`lock:leader:${name}`, ttlMs);
    if (!token) return false;
    await fn();
    return true;
  }

  async withDeviceLocks<T>(
    deviceIds: string[],
    fn: () => Promise<T>,
    opts: DeviceLockOptions = {},
  ): Promise<T> {
    const ttlMs = opts.ttlMs ?? 60_000;
    const renewEveryMs = opts.renewEveryMs ?? 20_000;
    const waitTimeoutMs =
      opts.waitTimeoutMs ?? (Number(process.env.DEVICE_LOCK_WAIT_MS) || 900_000);
    const pollMs = opts.pollMs ?? 2000;

    const ids = [...new Set(deviceIds.filter((id) => !!id))].sort();
    const keys = ids.map((id) => `lock:device:${id}`);

    const held = new Map<string, string>();
    const start = Date.now();
    let delay = pollMs;

    try {
      while (true) {
        let busy: string | null = null;
        for (let i = 0; i < keys.length; i++) {
          const token = await this.tryAcquire(keys[i], ttlMs);
          if (!token) {
            busy = ids[i];
            break;
          }
          held.set(keys[i], token);
        }
        if (busy === null) break;

        await this.releaseAll(held);
        const elapsed = Date.now() - start;
        if (elapsed >= waitTimeoutMs) {
          throw new DeviceBusyTimeoutError(ids, elapsed);
        }
        await sleep(Math.min(delay, Math.max(waitTimeoutMs - elapsed, 1)));
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }

      const timer = setInterval(() => {
        for (const [key, token] of held) {
          this.renew(key, token, ttlMs)
            .then((ok) => {
              if (!ok) this.logger.warn(`Device lock ${key} lost before renewal`);
            })
            .catch((e: Error) => this.logger.warn(`Renew of ${key} failed: ${e.message}`));
        }
      }, renewEveryMs);
      try {
        return await fn();
      } finally {
        clearInterval(timer);
      }
    } finally {
      await this.releaseAll(held);
    }
  }

  private async releaseAll(held: Map<string, string>): Promise<void> {
    const entries = [...held];
    held.clear();
    await Promise.all(
      entries.map(([key, token]) =>
        this.release(key, token).catch((e: Error) =>
          this.logger.warn(`Release of ${key} failed: ${e.message}`),
        ),
      ),
    );
  }
}
