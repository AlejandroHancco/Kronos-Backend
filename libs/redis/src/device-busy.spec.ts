import { ConflictException } from '@nestjs/common';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { DEVICE_BUSY_MARKER, DeviceStateService, RedisLockService, deviceBusyMessage } from './index';

describe('deviceBusyMessage', () => {
  it('es el texto del 409 (dispositivo midiendo o configurándose), con el nombre entre comillas', () => {
    expect(deviceBusyMessage('MUX')).toBe('"MUX" está ocupado (midiendo o aplicando otra configuración); espera a que termine');
    expect(deviceBusyMessage('MUX').endsWith(DEVICE_BUSY_MARKER)).toBe(true);
  });

  it('DeviceStateService.withExclusive lanza el 409 con ese mismo texto', async () => {
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    const locks = new RedisLockService(redis);
    await locks.tryAcquire('lock:device:m', 60_000);
    const state = new DeviceStateService(redis, locks, {} as any);
    await expect(state.withExclusive({ id: 'm', name: 'MUX' }, jest.fn())).rejects.toThrow(
      new ConflictException(deviceBusyMessage('MUX')),
    );
    redis.disconnect();
  });
});
