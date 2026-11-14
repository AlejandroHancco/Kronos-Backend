import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { DeviceBusyTimeoutError, RedisLockService } from './redis-lock.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RedisLockService', () => {
  let redis: Redis;
  let service: RedisLockService;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    service = new RedisLockService(redis);
  });

  afterEach(() => {
    redis.disconnect();
  });

  it('runAsLeader runs fn only once within the TTL', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    expect(await service.runAsLeader('tick', 5000, fn)).toBe(true);
    expect(await service.runAsLeader('tick', 5000, fn)).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withDeviceLocks serializes calls sharing a device', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));

    const first = service.withDeviceLocks(['m1', 'a1'], async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    await sleep(30);
    const second = service.withDeviceLocks(
      ['m1'],
      async () => {
        order.push('second:start');
      },
      { pollMs: 10 },
    );
    await sleep(60);
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(await redis.exists('lock:device:m1', 'lock:device:a1')).toBe(0);
  });

  it('recovers when a holder crashed without releasing (TTL expiry)', async () => {
    await service.tryAcquire('lock:device:m1', 100);
    const fn = jest.fn().mockResolvedValue('ok');
    const start = Date.now();
    await expect(service.withDeviceLocks(['m1'], fn, { pollMs: 20 })).resolves.toBe('ok');
    expect(Date.now() - start).toBeGreaterThanOrEqual(80);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws DeviceBusyTimeoutError after waitTimeoutMs', async () => {
    await service.tryAcquire('lock:device:m1', 5000);
    const fn = jest.fn();
    const p = service.withDeviceLocks(['m1', 'a1'], fn, { waitTimeoutMs: 50, pollMs: 10 });
    await expect(p).rejects.toBeInstanceOf(DeviceBusyTimeoutError);
    await expect(p).rejects.toThrow(/m1/);
    expect(fn).not.toHaveBeenCalled();
    // partial acquisition (a1) must have been released
    expect(await redis.exists('lock:device:a1')).toBe(0);
  });

  it('release with a wrong token does not delete the key; renew checks token', async () => {
    const token = await service.tryAcquire('k', 5000);
    expect(token).toBeTruthy();
    await service.release('k', 'wrong');
    expect(await redis.exists('k')).toBe(1);
    expect(await service.renew('k', 'wrong', 5000)).toBe(false);
    expect(await service.renew('k', token!, 5000)).toBe(true);
    await service.release('k', token!);
    expect(await redis.exists('k')).toBe(0);
  });

  it('releases locks and rethrows when fn throws; ignores empty ids', async () => {
    await expect(
      service.withDeviceLocks(['m1', 'm1', '', null as any, undefined as any], async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await redis.keys('lock:device:*')).toEqual([]);
  });
});
