import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { TaskPreferencesService } from '../task-preferences/task-preferences.service';

@Module({
  imports: [PrismaModule, SchedulerModule],
  controllers: [TasksController],
  providers: [TasksService, TaskPreferencesService],
})
export class TasksModule {}
