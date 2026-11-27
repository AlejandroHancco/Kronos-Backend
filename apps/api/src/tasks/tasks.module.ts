import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { PrismaModule } from '@app/database';
import { SeriesReservationsModule } from '@app/measurement';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { TaskPreferencesService } from '../task-preferences/task-preferences.service';

@Module({
  imports: [PrismaModule, SchedulerModule, SeriesReservationsModule],
  controllers: [TasksController],
  providers: [TasksService, TaskPreferencesService],
})
export class TasksModule {}
