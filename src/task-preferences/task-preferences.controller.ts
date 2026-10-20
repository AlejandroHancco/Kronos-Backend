import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { NormalizedUser } from '../auth/interfaces/auth.interface';
import { CreateTaskPreferenceDto } from './dto/create-task-preference.dto';
import { UpdateTaskPreferenceDto } from './dto/update-task-preference.dto';
import { TaskPreferencesService } from './task-preferences.service';

@Controller('tasks')
@UseGuards(JwtAuthGuard)
export class TaskPreferencesController {
  constructor(private readonly taskPreferencesService: TaskPreferencesService) {}

  @Get(':taskId/preference')
  getTaskPreference(
    @Param('taskId', ParseIntPipe) taskId: number,
    @CurrentUser() user: NormalizedUser,
  ) {
    return this.taskPreferencesService.getTaskPreference(taskId, user.id);
  }

  @Post(':taskId/preference')
  createTaskPreference(
    @Param('taskId', ParseIntPipe) taskId: number,
    @Body() createTaskPreferenceDto: CreateTaskPreferenceDto,
    @CurrentUser() user: NormalizedUser,
  ) {
    return this.taskPreferencesService.createTaskPreference(
      taskId,
      createTaskPreferenceDto,
      user.id,
    );
  }

  @Put(':taskId/preference')
  updateTaskPreference(
    @Param('taskId', ParseIntPipe) taskId: number,
    @Body() updateTaskPreferenceDto: UpdateTaskPreferenceDto,
    @CurrentUser() user: NormalizedUser,
  ) {
    return this.taskPreferencesService.updateTaskPreference(
      taskId,
      updateTaskPreferenceDto,
      user.id,
    );
  }

  @Delete(':taskId/preference')
  removeTaskPreference(
    @Param('taskId', ParseIntPipe) taskId: number,
    @CurrentUser() user: NormalizedUser,
  ) {
    return this.taskPreferencesService.removeTaskPreference(taskId, user.id);
  }
}
