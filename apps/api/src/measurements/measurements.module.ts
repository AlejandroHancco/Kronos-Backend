import { Module } from '@nestjs/common';
import { MeasurementsService } from './measurements.service';
import { MeasurementsController } from './measurements.controller';
import { MeasurementsGateway } from './measurements.gateway';
import { PrismaService } from '@app/database';

@Module({
  controllers: [MeasurementsController],
  providers: [MeasurementsService, MeasurementsGateway, PrismaService],
  exports: [MeasurementsService],
})
export class MeasurementsModule {}
