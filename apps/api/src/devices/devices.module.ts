import { Module } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { DevicesController, ProjectDevicesController } from './devices.controller';
import { PrismaService } from '@app/database';

@Module({
  controllers: [DevicesController, ProjectDevicesController],
  providers: [DevicesService, PrismaService],
  exports: [DevicesService],
})
export class DevicesModule {}
