import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { CommonModule } from '@app/common';
import { LaasCatalogModule } from '@app/laas-catalog';
import { DeviceDriversModule } from '@app/device-drivers';
import { NotificationsModule } from '@app/notifications';
import { MeasurementExecutor } from './measurement.executor';

// RealtimeModule es @Global en la app anfitriona: RealtimePublisher se resuelve sin importarlo aquí.
@Module({
  imports: [PrismaModule, CommonModule, LaasCatalogModule, DeviceDriversModule, NotificationsModule],
  providers: [MeasurementExecutor],
  exports: [MeasurementExecutor],
})
export class MeasurementModule {}
