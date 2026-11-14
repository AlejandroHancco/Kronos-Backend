import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@app/database';
import { RedisModule } from '@app/redis';
import { QueueModule } from '@app/queue';
import { RealtimeModule } from '@app/realtime';
import { NotificationsModule } from '@app/notifications';
import { MeasurementModule } from '@app/measurement';
import { DevicePluginsModule } from '@app/device-plugins';
import { HealthController } from './health.controller';
import { SchedulerService } from './scheduler/scheduler.service';
import { MeasurementProcessor } from './processors/measurement.processor';
import { DeviceOpsProcessor } from './processors/device-ops.processor';
import { DeviceHealthService } from './devices/device-health.service';

/**
 * Worker: consume las colas Bull (mediciones, device-ops), corre el cron de
 * ScheduledJobs y el health check de dispositivos (ambos con elección de líder).
 * Solo expone GET /health; sin WebSockets (publica eventos vía RealtimePublisher).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    QueueModule,
    RealtimeModule,
    NotificationsModule,
    MeasurementModule,
    DevicePluginsModule,
  ],
  controllers: [HealthController],
  providers: [SchedulerService, MeasurementProcessor, DeviceHealthService, DeviceOpsProcessor],
})
export class WorkerModule {}
