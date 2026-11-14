import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { TasksService } from '../tasks/tasks.service';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { DevicesModule } from '../devices/devices.module';

@Module({
  imports: [PrismaModule, SchedulerModule, DevicesModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, TasksService],
})
export class ProjectsModule {}
