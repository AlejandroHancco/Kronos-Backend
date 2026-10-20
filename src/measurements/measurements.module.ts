import { Module } from '@nestjs/common';
import { MeasurementsService } from './measurements.service';
import { MeasurementsController } from './measurements.controller';
import { MeasurementsGateway } from './measurements.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [MeasurementsController],
  providers: [MeasurementsService, MeasurementsGateway, PrismaService],
  exports: [MeasurementsService, MeasurementsGateway],
})
export class MeasurementsModule {}
