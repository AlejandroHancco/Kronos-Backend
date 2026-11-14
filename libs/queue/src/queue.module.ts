import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { DEVICE_OPS_QUEUE, MEASUREMENTS_QUEUE } from './queue.constants';

/**
 * Configura Bull con Redis (REDIS_URL obligatorio, ej. Upstash: rediss://...).
 * Si REDIS_URL falta, el arranque falla (al resolver el módulo, no al importarlo).
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const url = process.env.REDIS_URL;
        if (!url) throw new Error('REDIS_URL is required');
        return { url };
      },
    }),
    BullModule.registerQueue({ name: MEASUREMENTS_QUEUE }, { name: DEVICE_OPS_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
