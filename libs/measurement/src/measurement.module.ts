import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { CommonModule } from '@app/common';
import { ExperimentsModule } from '@app/experiments';
import { RealtimeModule } from '@app/realtime';
import { DeviceDriversModule } from '@app/device-drivers';
import { NotificationsModule } from '@app/notifications';
import { MeasurementExecutor } from './measurement.executor';

@Module({
  imports: [PrismaModule, CommonModule, ExperimentsModule, DeviceDriversModule, NotificationsModule, RealtimeModule],
  providers: [MeasurementExecutor],
  exports: [MeasurementExecutor],
})
export class MeasurementModule {}
