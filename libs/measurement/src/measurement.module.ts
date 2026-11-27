import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { CommonModule } from '@app/common';
import { ExperimentsModule } from '@app/experiments';
import { RealtimeModule } from '@app/realtime';
import { DeviceDriversModule } from '@app/device-drivers';
import { NotificationsModule } from '@app/notifications';
import { MeasurementExecutor } from './measurement.executor';
import { SeriesReservationsModule } from './series-reservations.module';

@Module({
  imports: [PrismaModule, CommonModule, ExperimentsModule, DeviceDriversModule, NotificationsModule, RealtimeModule, SeriesReservationsModule],
  providers: [MeasurementExecutor],
  exports: [MeasurementExecutor, SeriesReservationsModule],
})
export class MeasurementModule {}
