import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@app/database';
import { RedisModule } from '@app/redis';
import { CommonModule } from '@app/common';
import { QueueModule } from '@app/queue';
import { RealtimeModule } from '@app/realtime';
import { NotificationsModule } from '@app/notifications';
import { LaasCatalogModule } from '@app/laas-catalog';
import { DeviceDriversModule } from '@app/device-drivers';
import { ExperimentsModule } from '@app/experiments';
import { MeasurementModule } from '@app/measurement';
import { HealthController } from './health.controller';
import { DriverParityCheck } from './driver-parity.check';
import { SchedulerService } from './scheduler/scheduler.service';
import { MeasurementProcessor } from './processors/measurement.processor';
import { DeviceOpsProcessor } from './processors/device-ops.processor';
import { DeviceHealthService } from './devices/device-health.service';
import { DeviceReachability } from './devices/device-reachability';

/**
 * Worker: el ejecutor LaaS, único proceso que habla con los dispositivos. Consume las colas Bull
 * (mediciones, device-ops), corre el cron de ScheduledJobs y el health check de dispositivos (ambos
 * con elección de líder). Solo expone GET /health; sin WebSockets (publica eventos vía
 * RealtimePublisher, cuyo deviceStatus necesita TeamScopeService de CommonModule).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    CommonModule,
    QueueModule,
    RealtimeModule,
    NotificationsModule,
    LaasCatalogModule,
    DeviceDriversModule,
    ExperimentsModule,
    MeasurementModule,
  ],
  controllers: [HealthController],
  providers: [
    DriverParityCheck,
    DeviceReachability,
    SchedulerService,
    MeasurementProcessor,
    DeviceHealthService,
    DeviceOpsProcessor,
  ],
})
export class WorkerModule {}
