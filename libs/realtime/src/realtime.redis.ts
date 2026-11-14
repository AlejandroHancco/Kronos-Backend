import { Logger } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';

/** Cliente ioredis dedicado al emitter de Socket.io (no el REDIS_CLIENT compartido). */
export const REALTIME_REDIS_CLIENT = Symbol('REALTIME_REDIS_CLIENT');

/**
 * El REDIS_CLIENT compartido usa enableOfflineQueue:false (falla rápido), y el
 * emitter no maneja la promesa de publish(): un corte breve de Redis acababa en
 * un unhandled rejection. Este cliente encola mientras reconecta y acota los
 * reintentos; los fallos que aún lleguen los absorbe RealtimePublisher.
 */
export function createRealtimeRedisClient(overrides: RedisOptions = {}): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is required');
  }

  const client = new Redis(url, {
    enableOfflineQueue: true,
    maxRetriesPerRequest: 3,
    ...overrides,
  });

  client.on('error', (err) => {
    Logger.warn(`Realtime Redis connection error: ${err.message}`, 'RealtimePublisher');
  });

  return client;
}
