import { Module } from '@nestjs/common';
import { MeasurementChannelsService } from './measurement-channels.service';
import { MeasurementChannelsController } from './measurement-channels.controller';
import { PrismaModule } from '@app/database';

@Module({
  imports: [PrismaModule],
  controllers: [MeasurementChannelsController],
  providers: [MeasurementChannelsService],
  exports: [MeasurementChannelsService],
})
export class MeasurementChannelsModule {}

