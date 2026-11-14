import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { QueueModule } from '@app/queue';
import { MeasurementSchedulingService } from './scheduling.service';
import { SchedulerController } from './scheduler.controller';

/**
 * Control de admisión de mediciones manuales (MeasurementSchedulingService):
 * estimación aditiva por rangos × canales, límite de backlog y conflicto con
 * mediciones programadas.
 *
 * El cron de ScheduledJobs (SchedulerService) y el consumidor de la cola (MeasurementProcessor)
 * viven en el worker (apps/worker).
 */
@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [SchedulerController],
  providers: [MeasurementSchedulingService],
  exports: [MeasurementSchedulingService],
})
export class SchedulerModule {}
