import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { ConflictException } from '@nestjs/common';
import { DeviceStateService } from './device-state.service';
import { RedisLockService } from './redis-lock.service';

const prisma = (running: string[] = []) => ({
  scheduledJob: { findMany: jest.fn(async () => (running.length ? [{ taskId: 1 }] : [])) },
  taskPreference: {
    findMany: jest.fn(async () => (running.length ? [{ sensorDeviceId: running[0], channelSelectorDeviceId: running[1] ?? null }] : [])),
  },
});

describe('DeviceStateService', () => {
  let redis: Redis;
  let locks: RedisLockService;
  const make = (running: string[] = []) => new DeviceStateService(redis, locks, prisma(running) as any);

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    locks = new RedisLockService(redis);
  });
  afterEach(() => redis.disconnect());

  it('isBusy: false sin lock ni job running', async () => {
    expect(await make().isBusy('m')).toBe(false);
  });

  it('isBusy: true mientras existe lock:device:<id> y false al liberarlo', async () => {
    const token = await locks.tryAcquire('lock:device:m', 60_000);
    expect(await make().isBusy('m')).toBe(true);
    await locks.release('lock:device:m', token!);
    expect(await make().isBusy('m')).toBe(false);
  });

  it('isBusy: true si un job programado running usa el dispositivo', async () => {
    expect(await make(['s', 'm']).isBusy('m')).toBe(true);
    expect(await make(['s', 'm']).isBusy('x')).toBe(false);
  });

  it('withExclusive: 409 mientras una medición tiene el lock', async () => {
    await locks.tryAcquire('lock:device:m', 60_000);
    const fn = jest.fn();
    await expect(make().withExclusive({ id: 'm', name: 'MUX' }, fn)).rejects.toThrow(
      new ConflictException('"MUX" está midiendo; espera a que termine para cambiar su configuración'),
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('withExclusive: ejecuta si está libre, mantiene el lock durante fn y lo libera', async () => {
    const state = make();
    const result = await state.withExclusive({ id: 'm', name: 'MUX' }, async () => {
      expect(await redis.exists('lock:device:m')).toBe(1);
      return 7;
    });
    expect(result).toBe(7);
    expect(await redis.exists('lock:device:m')).toBe(0);
  });

  it('withExclusive: libera aunque fn falle', async () => {
    const state = make();
    await expect(state.withExclusive({ id: 'm', name: 'MUX' }, async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await redis.exists('lock:device:m')).toBe(0);
    await expect(state.withExclusive({ id: 'm', name: 'MUX' }, async () => 1)).resolves.toBe(1);
  });
});
