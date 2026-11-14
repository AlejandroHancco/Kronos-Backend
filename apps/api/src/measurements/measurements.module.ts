import { Module } from '@nestjs/common';
import { MeasurementsService } from './measurements.service';
import { MeasurementsController } from './measurements.controller';
import { MeasurementsGateway } from './measurements.gateway';
import { PrismaModule } from '@app/database';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [MeasurementsController],
  providers: [MeasurementsService, MeasurementsGateway],
  exports: [MeasurementsService, MeasurementsGateway],
})
export class MeasurementsModule {}
