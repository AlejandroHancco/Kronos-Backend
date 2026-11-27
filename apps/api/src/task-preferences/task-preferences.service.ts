import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Device, Prisma, TaskPreference } from '@prisma/client';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { ExperimentConfigService, toSweepRanges } from '@app/experiments';
import { estimateSeconds, ReservedSecondsUpdate, SeriesReservationsService } from '@app/measurement';
import { invalidChannels } from '@app/laas-catalog';
import { SweepRange } from '@app/laas-catalog';
import { CreateTaskPreferenceDto, TaskPreferenceRangeDto } from './dto/create-task-preference.dto';
import { UpdateTaskPreferenceDto } from './dto/update-task-preference.dto';

/** Rangos del DTO (puntos/escala opcionales) con los mismos valores por defecto que aplica la BD. */
const toValidationRanges = (ranges: TaskPreferenceRangeDto[]): SweepRange[] =>
  ranges.map((r) => ({ start: r.start, stop: r.stop, points: r.points ?? 801, scale: r.scale ?? 'LIN' }));

export interface TaskPreferenceResponse {
  id: number;
  taskId: number;
  name: string;
  ranges: {
    id: number;
    order: number;
    start: number;
    stop: number;
    points: number;
    scale: string;
  }[];
  createdAt: string;
  updatedAt: string;
  sensorDevice: {
    id: string;
    name: string;
    type: string | null;
    ip: string | null;
  };
  channelSelectorDevice: {
    id: string;
    name: string;
    type: string | null;
    ip: string | null;
  } | null;
}

/**
 * Aviso no bloqueante tras guardar: jobs programados pendientes cuyos canales quedaron fuera
 * del rango de la nueva configuración. No se marcan como failed aquí (ScheduledJob no tiene
 * columna de motivo); al ejecutarse fallarán con el mensaje de rango y se notificará al equipo.
 */
export interface TaskPreferenceWarning {
  code: 'scheduled_jobs_out_of_range';
  message: string;
  scheduledJobIds: number[];
}

export type TaskPreferenceSaveResponse = TaskPreferenceResponse & { warnings: TaskPreferenceWarning[] };

type TaskPreferenceWithDevices = TaskPreference & {
  sensorDevice: Device;
  channelSelectorDevice: Device | null;
  ranges: any[];
};

@Injectable()
export class TaskPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teamScope: TeamScopeService,
    private readonly experimentConfig: ExperimentConfigService,
    private readonly seriesReservations: SeriesReservationsService,
  ) {}

  async getTaskPreference(taskId: number, userId: string): Promise<TaskPreferenceResponse | null> {
    await this.teamScope.assertTaskInTeam(userId, taskId);
    const preference = await this.prisma.taskPreference.findUnique({
      where: { taskId },
      include: {
        sensorDevice: true,
        channelSelectorDevice: true,
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
  ): Promise<TaskPreferenceSaveResponse> {
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
      dto.sensorDeviceId,
      dto.channelSelectorDeviceId ?? null,
      toValidationRanges(dto.ranges),
    );

    const preference = await this.prisma.taskPreference.create({
      data: {
        taskId,
        name: dto.name,
        sensorDeviceId: dto.sensorDeviceId,
        channelSelectorDeviceId: dto.channelSelectorDeviceId ?? null,
        ranges: {
          create: dto.ranges.map((r) => ({
            order: r.order,
            start: r.start,
            stop: r.stop,
            points: r.points,
            scale: r.scale,
          })),
        },
      },
      include: {
        sensorDevice: true,
        channelSelectorDevice: true,
        ranges: {
          orderBy: { order: 'asc' },
        },
      },
    });

    return { ...this.mapToResponse(preference), warnings: await this.scheduledJobWarnings(taskId, preference) };
  }

  async updateTaskPreference(
    taskId: number,
    dto: UpdateTaskPreferenceDto,
    userId: string,
  ): Promise<TaskPreferenceSaveResponse> {
    await this.teamScope.assertTaskInTeam(userId, taskId);

    let reservedUpdates: ReservedSecondsUpdate[];
    {
      const current = await this.prisma.taskPreference.findUnique({
        where: { taskId },
        include: { ranges: { orderBy: { order: 'asc' } } },
      });
      if (!current) {
        throw new NotFoundException('TaskPreference no encontrada');
      }
      const sensorDeviceId = dto.sensorDeviceId ?? current.sensorDeviceId;
      const channelSelectorDeviceId =
        dto.channelSelectorDeviceId !== undefined ? dto.channelSelectorDeviceId : current.channelSelectorDeviceId;
      const ranges = dto.ranges ? toValidationRanges(dto.ranges) : toSweepRanges(current.ranges);
      const acquisition = await this.experimentConfig.assertValidConfig(
        taskId,
        sensorDeviceId,
        channelSelectorDeviceId ?? null,
        ranges,
      );
      // Series pendientes de la tarea: con los nuevos dispositivos y la nueva reserva no pueden pisar
      // otras series (409 y no se guarda). Sin series pendientes no hace nada.
      const devices = channelSelectorDeviceId ? [sensorDeviceId, channelSelectorDeviceId] : [sensorDeviceId];
      reservedUpdates = await this.seriesReservations.revalidateTask(taskId, devices, (channelCount) =>
        estimateSeconds(acquisition, ranges, channelCount, !!channelSelectorDeviceId),
      );
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
                  start: r.start,
                  stop: r.stop,
                  points: r.points,
                  scale: r.scale,
                })),
              }
            : undefined,
        },
        include: {
          sensorDevice: true,
          channelSelectorDevice: true,
          ranges: {
            orderBy: { order: 'asc' },
          },
        },
      });
      await this.seriesReservations.applyReservedSeconds(reservedUpdates);

      return { ...this.mapToResponse(preference), warnings: await this.scheduledJobWarnings(taskId, preference) };
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
          sensorDevice: true,
          channelSelectorDevice: true,
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

  /** Jobs pendientes de la tarea con canales fuera del rango de la configuración recién guardada. */
  private async scheduledJobWarnings(
    taskId: number,
    preference: TaskPreferenceWithDevices,
  ): Promise<TaskPreferenceWarning[]> {
    const { channelRange } = this.experimentConfig.summarize(preference);
    const pending = await this.prisma.scheduledJob.findMany({
      where: { taskId, status: 'pending' },
      select: { id: true, channelNumbers: true },
    });
    const ids = pending.filter((j) => invalidChannels(j.channelNumbers, channelRange).length > 0).map((j) => j.id);
    if (ids.length === 0) return [];
    return [{
      code: 'scheduled_jobs_out_of_range',
      scheduledJobIds: ids,
      message: `Hay ${ids.length} mediciones programadas pendientes con canales fuera del rango de esta configuración (permitidos: ${channelRange.min}–${channelRange.max}): jobs ${ids.join(', ')}. Fallarán al ejecutarse; cancélalas o reprográmalas.`,
    }];
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
        start: Number(r.start),
        stop: Number(r.stop),
        points: r.points,
        scale: r.scale,
      })),
      createdAt: preference.createdAt?.toISOString() ?? '',
      updatedAt: preference.updatedAt?.toISOString() ?? '',
      sensorDevice: {
        id: preference.sensorDevice.id,
        name: preference.sensorDevice.name,
        type: preference.sensorDevice.type,
        ip: preference.sensorDevice.ip,
      },
      channelSelectorDevice: preference.channelSelectorDevice
        ? {
            id: preference.channelSelectorDevice.id,
            name: preference.channelSelectorDevice.name,
            type: preference.channelSelectorDevice.type,
            ip: preference.channelSelectorDevice.ip,
          }
        : null,
    };
  }
}
