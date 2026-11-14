import { Module } from '@nestjs/common';
import { TaskChannelsService } from './task-channels.service';
import { TaskChannelsController } from './task-channels.controller';
import { PrismaModule } from '@app/database';

@Module({
  imports: [PrismaModule],
  controllers: [TaskChannelsController],
  providers: [TaskChannelsService],
  exports: [TaskChannelsService],
})
export class TaskChannelsModule {}

