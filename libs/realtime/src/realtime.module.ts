import { Global, Module } from '@nestjs/common';
import { RealtimePublisher } from './realtime.publisher';
import { REALTIME_REDIS_CLIENT, createRealtimeRedisClient } from './realtime.redis';

/**
 * RealtimePublisher usa su propio cliente Redis (offline queue activada), no el
 * REDIS_CLIENT compartido, que falla rápido cuando Redis no está listo.
 * El publisher cierra este cliente en onModuleDestroy.
 */
@Global()
@Module({
  providers: [
    { provide: REALTIME_REDIS_CLIENT, useFactory: () => createRealtimeRedisClient() },
    RealtimePublisher,
  ],
  exports: [RealtimePublisher],
})
export class RealtimeModule {}
