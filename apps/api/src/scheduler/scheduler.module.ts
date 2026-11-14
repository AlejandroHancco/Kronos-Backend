import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { QueueModule } from '@app/queue';
import { MeasurementSchedulingService } from './scheduling.service';
import { SchedulerController } from './scheduler.controller';

/**
 * Control de admisión de mediciones manuales (MeasurementSchedulingService):
 * estimación aditiva por rangos × canales, límite de backlog y conflicto con
 * mediciones programadas. Encola en Bull; el cron y el processor viven en el worker.
 */
@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [SchedulerController],
  providers: [MeasurementSchedulingService],
  exports: [MeasurementSchedulingService],
})
export class SchedulerModule {}
