import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { CommonModule } from '@app/common';
import { DevicePluginsModule } from '@app/device-plugins';
import { NotificationsModule } from '@app/notifications';
import { RealtimeModule } from '@app/realtime';
import { MeasurementExecutor } from './measurement.executor';

@Module({
  imports: [PrismaModule, CommonModule, DevicePluginsModule, NotificationsModule, RealtimeModule],
  providers: [MeasurementExecutor],
  exports: [MeasurementExecutor],
})
export class MeasurementModule {}
