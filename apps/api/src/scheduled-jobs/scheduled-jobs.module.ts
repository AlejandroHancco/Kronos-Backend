import { Module } from '@nestjs/common';
import { ScheduledJobsService } from './scheduled-jobs.service';
import { ScheduledJobsController } from './scheduled-jobs.controller';
import { PrismaModule } from '@app/database';
import { SeriesReservationsModule } from '@app/measurement';

@Module({
  imports: [PrismaModule, SeriesReservationsModule],
  controllers: [ScheduledJobsController],
  providers: [ScheduledJobsService],
  exports: [ScheduledJobsService],
})
export class ScheduledJobsModule {}
