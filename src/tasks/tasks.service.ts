import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TeamScopeService } from '../common/team-scope.service';
import { MeasurementSchedulingService } from '../scheduler/scheduling.service';
import { ExperimentConfigService } from '../device-plugins/core/experiment-config.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MeasureDto } from './dto/measure.dto';
import { channelNumbersOf, parseAcquisitionSnapshot, storedPointsOf } from '../measurements/measurement-data';

@Injectable()
export class TasksService {
  constructor(
    private prisma: PrismaService,
    private teamScope: TeamScopeService,
    private schedulingService: MeasurementSchedulingService,
    private experimentConfig: ExperimentConfigService,
  ) {}

  async create(createTaskDto: CreateTaskDto, userId: string) {
    await this.teamScope.assertProjectInTeam(userId, createTaskDto.projectId);
    return this.prisma.task.create({
      data: createTaskDto,
    });
  }

  async findAll(userId: string) {
    // Solo tasks de proyectos del equipo del usuario
    const teamWhere = await this.teamScope.projectWhereForUser(userId);
    return this.prisma.task.findMany({
      where: { project: teamWhere },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number, userId: string) {
    await this.teamScope.assertTaskInTeam(userId, id);
    return this.prisma.task.findUnique({
      where: { id },
    });
  }

  async update(id: number, updateTaskDto: UpdateTaskDto, userId: string) {
    await this.teamScope.assertTaskInTeam(userId, id);
    return this.prisma.task.update({
      where: { id },
      data: updateTaskDto,
    });
  }

  async remove(id: number, userId: string) {
    await this.teamScope.assertTaskInTeam(userId, id);
    return this.prisma.task.delete({
      where: { id },
    });
  }

  async findByProject(projectId: string, userId: string, page: number = 1, limit: number = 10) {
    await this.teamScope.assertProjectInTeam(userId, projectId);
    const skip = (page - 1) * limit;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where: { projectId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.task.count({
        where: { projectId },
      }),
    ]);

    return { items, total, page, limit };
  }

  async findOneWithPreference(id: number, userId: string) {
    await this.teamScope.assertTaskInTeam(userId, id);
    const task = await this.prisma.task.findUnique({
      where: { id },
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const activePreference = await this.prisma.taskPreference.findFirst({
      where: { taskId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        sensorDevice: true,
        channelSelectorDevice: true,
        ranges: {
          orderBy: { order: 'asc' },
        },
      },
    });

    return {
      ...task,
      activePreference: activePreference
        ? { ...activePreference, ...this.experimentConfig.summarize(activePreference) }
        : null,
    };
  }

  async getMeasurements(taskId: number, userId: string) {
    await this.teamScope.assertTaskInTeam(userId, taskId);
    // measurementChannels y data se cargan en la misma consulta (sin N+1): data solo se expone
    // en la respuesta para lecturas puntuales (un punto, chico); los barridos mantienen la forma
    // actual de la lista (sin data completo) para no inflar el payload.
    const measurements = await this.prisma.measurement.findMany({
      where: { taskId },
      orderBy: { takenAt: 'desc' },
      select: {
        id: true,
        takenAt: true,
        takenBy: true,
        start: true,
        stop: true,
        sensorDeviceName: true,
        channelSelectorName: true,
        acquisition: true,
        data: true,
        measurementChannels: { select: { channelNumber: true } },
      },
    });

    return measurements.map(({ measurementChannels, data, ...m }) => {
      const acquisition = parseAcquisitionSnapshot(m.acquisition);
      return {
        ...m,
        start: m.start === null ? null : Number(m.start),
        stop: m.stop === null ? null : Number(m.stop),
        acquisition,
        channels: channelNumbersOf(measurementChannels),
        ...(acquisition.kind === 'single' ? { data: storedPointsOf(data) } : {}),
      };
    });
  }

  async measure(taskId: number, dto: MeasureDto, userId: string) {
    await this.teamScope.assertTaskInTeam(userId, taskId);
    const jobId = `${taskId}-${Date.now()}`;
    // Control de admisión: encola si hay capacidad, 409 si la cola está
    // llena o chocaría con una medición programada (mismos dispositivos)
    return this.schedulingService.requestMeasurement(taskId, userId, {
      ranges: dto.ranges,
      selectedChannels: dto.selectedChannels,
      jobId,
    });
  }
}
