import { Global, Module, Logger, Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import { RedisLockService } from './redis-lock.service';

export { REDIS_CLIENT };

/**
 * Cliente ioredis compartido (caché de permisos, health check, colas).
 * REDIS_URL es obligatorio: si falta, el arranque falla.
 */
const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (): Redis => {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL is required');
    }

    const client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false, // fallar rápido si Redis está caído (los consumidores degradan)
    });

    client.on('error', (err) => {
      Logger.warn(`Redis connection error: ${err.message}`, 'RedisModule');
    });

    return client;
  },
};

@Global()
@Module({
  providers: [redisProvider, RedisLockService],
  exports: [redisProvider, RedisLockService],
})
export class RedisModule {}
