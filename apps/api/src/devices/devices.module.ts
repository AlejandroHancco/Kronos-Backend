import { Module } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { DevicesController, ProjectDevicesController } from './devices.controller';
import { DeviceConfigurationService } from './device-configuration.service';
import { PrismaModule } from '@app/database';
import { QueueModule } from '@app/queue';

@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [DevicesController, ProjectDevicesController],
  providers: [DevicesService, DeviceConfigurationService],
  exports: [DevicesService],
})
export class DevicesModule {}
