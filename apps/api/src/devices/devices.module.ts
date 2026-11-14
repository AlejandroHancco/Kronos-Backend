import { Module } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { DevicesController, ProjectDevicesController } from './devices.controller';
import { PrismaService } from '@app/database';
import { QueueModule } from '@app/queue';

@Module({
  imports: [QueueModule],
  controllers: [DevicesController, ProjectDevicesController],
  providers: [DevicesService, PrismaService],
  exports: [DevicesService],
})
export class DevicesModule {}
