import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Device, Prisma, TaskPreference } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TeamScopeService } from '../common/team-scope.service';
import { ExperimentConfigService } from '../device-plugins/experiment-config.service';
import { CreateTaskPreferenceDto } from './dto/create-task-preference.dto';
import { UpdateTaskPreferenceDto } from './dto/update-task-preference.dto';

export interface TaskPreferenceResponse {
  id: number;
  taskId: number;
  name: string;
  ranges: {
    id: number;
    order: number;
    startFreq: number;
    stopFreq: number;
    points: number;
    sweepType: string;
  }[];
  createdAt: string;
  updatedAt: string;
  analyzerDevice: {
    id: string;
    name: string;
    type: string | null;
    ip: string | null;
  };
  muxDevice: {
    id: string;
    name: string;
    type: string | null;
    ip: string | null;
  } | null;
}

type TaskPreferenceWithDevices = TaskPreference & {
  analyzerDevice: Device;
  muxDevice: Device | null;
  ranges: any[];
};

@Injectable()
export class TaskPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teamScope: TeamScopeService,
    private readonly experimentConfig: ExperimentConfigService,
  ) {}

  async getTaskPreference(taskId: number, userId: string): Promise<TaskPreferenceResponse | null> {
    await this.teamScope.assertTaskInTeam(userId, taskId);
    const preference = await this.prisma.taskPreference.findUnique({
      where: { taskId },
      include: {
        analyzerDevice: true,
        muxDevice: true,
        ranges: {
          orderBy: { order: 'asc' },
        },
      },
    });

    return preference ? this.mapToResponse(preference) : null;
  }

  async createTaskPreference(
    taskId: number,
    dto: CreateTaskPreferenceDto,
    userId: string,
  ): Promise<TaskPreferenceResponse> {
    await this.teamScope.assertTaskInTeam(userId, taskId);
    const existing = await this.prisma.taskPreference.findUnique({
      where: { taskId },
    });

    if (existing) {
      throw new HttpException(
        'Ya existe una preferencia para esta tarea',
        HttpStatus.CONFLICT,
      );
    }

    await this.experimentConfig.assertValidConfig(
      taskId,
      dto.analyzerDeviceId,
      dto.muxDeviceId ?? null,
    );

    const preference = await this.prisma.taskPreference.create({
      data: {
        taskId,
        name: dto.name,
        analyzerDeviceId: dto.analyzerDeviceId,
        muxDeviceId: dto.muxDeviceId ?? null,
        ranges: {
          create: dto.ranges.map((r) => ({
            order: r.order,
            startFreq: r.startFreq,
            stopFreq: r.stopFreq,
            points: r.points,
            sweepType: r.sweepType,
          })),
        },
      },
      include: {
        analyzerDevice: true,
        muxDevice: true,
        ranges: {
          orderBy: { order: 'asc' },
        },
      },
    });

    return this.mapToResponse(preference);
  }

  async updateTaskPreference(
    taskId: number,
    dto: UpdateTaskPreferenceDto,
    userId: string,
  ): Promise<TaskPreferenceResponse> {
    await this.teamScope.assertTaskInTeam(userId, taskId);

    if (dto.analyzerDeviceId !== undefined || dto.muxDeviceId !== undefined) {
      const current = await this.prisma.taskPreference.findUnique({ where: { taskId } });
      if (!current) {
        throw new NotFoundException('TaskPreference no encontrada');
      }
      const analyzerDeviceId = dto.analyzerDeviceId ?? current.analyzerDeviceId;
      const muxDeviceId =
        dto.muxDeviceId !== undefined ? dto.muxDeviceId : current.muxDeviceId;
      await this.experimentConfig.assertValidConfig(taskId, analyzerDeviceId, muxDeviceId ?? null);
    }

    try {
      const { ranges, ...data } = dto;
      const preference = await this.prisma.taskPreference.update({
        where: { taskId },
        data: {
          ...data,
          ranges: ranges
            ? {
                deleteMany: {},
                create: ranges.map((r) => ({
                  order: r.order,
                  startFreq: r.startFreq,
                  stopFreq: r.stopFreq,
                  points: r.points,
                  sweepType: r.sweepType,
                })),
              }
            : undefined,
        },
        include: {
          analyzerDevice: true,
          muxDevice: true,
          ranges: {
            orderBy: { order: 'asc' },
          },
        },
      });

      return this.mapToResponse(preference);
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new HttpException(
          'TaskPreference no encontrada',
          HttpStatus.NOT_FOUND,
        );
      }

      throw error;
    }
  }

  async removeTaskPreference(taskId: number, userId: string): Promise<TaskPreferenceResponse> {
    await this.teamScope.assertTaskInTeam(userId, taskId);
    try {
      const preference = await this.prisma.taskPreference.delete({
        where: { taskId },
        include: {
          analyzerDevice: true,
          muxDevice: true,
          ranges: true,
        },
      });

      return this.mapToResponse(preference);
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new HttpException(
          'TaskPreference no encontrada',
          HttpStatus.NOT_FOUND,
        );
      }

      throw error;
    }
  }

  private mapToResponse(
    preference: TaskPreferenceWithDevices,
  ): TaskPreferenceResponse {
    return {
      id: preference.id,
      taskId: preference.taskId,
      name: preference.name,
      ranges: preference.ranges.map((r) => ({
        id: r.id,
        order: r.order,
        startFreq: Number(r.startFreq),
        stopFreq: Number(r.stopFreq),
        points: r.points,
        sweepType: r.sweepType,
      })),
      createdAt: preference.createdAt?.toISOString() ?? '',
      updatedAt: preference.updatedAt?.toISOString() ?? '',
      analyzerDevice: {
        id: preference.analyzerDevice.id,
        name: preference.analyzerDevice.name,
        type: preference.analyzerDevice.type,
        ip: preference.analyzerDevice.ip,
      },
      muxDevice: preference.muxDevice
        ? {
            id: preference.muxDevice.id,
            name: preference.muxDevice.name,
            type: preference.muxDevice.type,
            ip: preference.muxDevice.ip,
          }
        : null,
    };
  }
}
