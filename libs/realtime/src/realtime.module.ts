import { Global, Module } from '@nestjs/common';
import { RedisModule } from '@app/redis';
import { RealtimePublisher } from './realtime.publisher';

@Global()
@Module({
  imports: [RedisModule],
  providers: [RealtimePublisher],
  exports: [RealtimePublisher],
})
export class RealtimeModule {}
