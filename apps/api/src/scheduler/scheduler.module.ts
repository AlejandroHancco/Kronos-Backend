import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { QueueModule } from '@app/queue';
import { SchedulerService } from './scheduler.service';
import { MeasurementSchedulingService } from './scheduling.service';
import { SchedulerController } from './scheduler.controller';

/**
 * Control de admisión de mediciones manuales (MeasurementSchedulingService):
 * estimación aditiva por rangos × canales, límite de backlog y conflicto con
 * mediciones programadas.
 *
 * SchedulerService (cron) y MeasurementProcessor (cola) no se registran aquí:
 * pasan al worker (sus archivos permanecen en esta carpeta hasta entonces).
 */
@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [SchedulerController],
  providers: [MeasurementSchedulingService],
  exports: [MeasurementSchedulingService],
})
export class SchedulerModule {}
