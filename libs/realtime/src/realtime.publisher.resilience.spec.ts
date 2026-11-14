import { Logger } from '@nestjs/common';
import { RealtimePublisher } from './realtime.publisher';
import { createRealtimeRedisClient } from './realtime.redis';

// Usa el Emitter real de @socket.io/redis-emitter: llama a redis.publish(...)
// sin manejar la promesa, así que un publish rechazado debe absorberse aquí.

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('RealtimePublisher resilience (Redis down)', () => {
  const unhandled = jest.fn();

  beforeAll(() => process.on('unhandledRejection', unhandled));
  afterAll(() => process.off('unhandledRejection', unhandled));

  beforeEach(() => {
    unhandled.mockClear();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('a rejected publish neither throws nor leaves an unhandled rejection', async () => {
    const redis = { publish: jest.fn().mockRejectedValue(new Error("Stream isn't writeable")) };
    const publisher = new RealtimePublisher(redis as any);

    expect(() => publisher.jobStatus('u1', { jobId: 'j', status: 'queued' })).not.toThrow();
    expect(() => publisher.measurementError('u1', 'j', 'boom')).not.toThrow();
    await flush();
    await flush();

    expect(redis.publish).toHaveBeenCalledTimes(2);
    expect(unhandled).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("Stream isn't writeable"),
    );
  });

  it('a synchronously throwing publish does not throw to the caller', () => {
    const redis = {
      publish: jest.fn(() => {
        throw new Error('closed');
      }),
    };
    const publisher = new RealtimePublisher(redis as any);
    expect(() => publisher.deviceStatus('d1', 'p1', 'online')).not.toThrow();
  });

  it('closes its dedicated client on module destroy', async () => {
    const redis = { publish: jest.fn(), quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() };
    const publisher = new RealtimePublisher(redis as any);
    await publisher.onModuleDestroy();
    expect(redis.quit).toHaveBeenCalled();
  });
});

describe('createRealtimeRedisClient', () => {
  const original = process.env.REDIS_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
  });

  it('fails fast without REDIS_URL', () => {
    delete process.env.REDIS_URL;
    expect(() => createRealtimeRedisClient()).toThrow(/REDIS_URL is required/);
  });

  it('uses an offline queue, bounded retries and logs connection errors', () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6399';
    const client = createRealtimeRedisClient({ lazyConnect: true });
    try {
      expect(client.options.enableOfflineQueue).toBe(true);
      expect(client.options.maxRetriesPerRequest).toBeGreaterThan(0);
      expect(client.options.maxRetriesPerRequest).toBeLessThanOrEqual(5);
      expect(client.listenerCount('error')).toBeGreaterThan(0);
    } finally {
      client.disconnect();
    }
  });
});
