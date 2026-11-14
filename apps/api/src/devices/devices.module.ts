import { Module } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { DeviceHealthService } from './device-health.service';
import { DevicesController, ProjectDevicesController } from './devices.controller';
import { PrismaModule } from '@app/database';

@Module({
  imports: [PrismaModule],
  controllers: [DevicesController, ProjectDevicesController],
  providers: [DevicesService, DeviceHealthService],
  exports: [DevicesService],
})
export class DevicesModule {}
