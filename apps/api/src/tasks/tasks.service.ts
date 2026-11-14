import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { MeasurementSchedulingService } from '../scheduler/scheduling.service';
import { ExperimentConfigService } from '@app/experiments';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MeasureDto } from './dto/measure.dto';
import { channelNumbersOf, parseAcquisitionSnapshot } from '@app/laas-catalog';
import { loadSingleReadings, singleReadingFields } from '../measurements/single-readings';

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
    // La lista no carga `data` (un barrido puede tener miles de puntos): measurementChannels viene en
    // la misma consulta (sin N+1) y el punto de las lecturas puntuales, junto con sus sensorValues,
    // llega en una segunda consulta acotada a esas mediciones.
    const rows = await this.prisma.measurement.findMany({
      where: { taskId },
      orderBy: { takenAt: 'desc' },
      select: {
        id: true,
        takenAt: true,
        takenBy: true,
        start: true,
        stop: true,
        scale: true,
        sensorDeviceName: true,
        channelSelectorName: true,
        acquisition: true,
        measurementChannels: { select: { channelNumber: true } },
      },
    });
    const measurements = rows.map((m) => ({ ...m, acquisition: parseAcquisitionSnapshot(m.acquisition) }));
    const singles = await loadSingleReadings(this.prisma, measurements);

    return measurements.map(({ measurementChannels, ...m }) => ({
      ...m,
      start: m.start === null ? null : Number(m.start),
      stop: m.stop === null ? null : Number(m.stop),
      channels: channelNumbersOf(measurementChannels),
      ...singleReadingFields(singles, m.id, m.acquisition),
    }));
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
