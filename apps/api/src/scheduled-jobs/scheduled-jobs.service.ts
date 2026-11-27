import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { ExperimentConfigService } from '@app/experiments';
import { SeriesConflictPair, SeriesReservationsService } from '@app/measurement';
import { CreateScheduledJobDto } from './dto/create-scheduled-job.dto';

@Injectable()
export class ScheduledJobsService {
  constructor(
    private prisma: PrismaService,
    private teamScope: TeamScopeService,
    private experimentConfig: ExperimentConfigService,
    private reservations: SeriesReservationsService,
  ) {}

  async create(createScheduledJobDto: CreateScheduledJobDto, userId: string) {
    const { taskId, toleranceMinutes = 5, ...data } = createScheduledJobDto;

    // Verificar que la tarea existe Y pertenece al equipo del usuario
    await this.teamScope.assertTaskInTeam(userId, taskId);
    await this.experimentConfig.assertChannels(taskId, data.channelNumbers);

    // Admisión: ninguna ocurrencia de la serie puede pisar otra serie pendiente en los mismos equipos
    const reservedSeconds = await this.reservations.reservedSecondsForTask(taskId, data.channelNumbers.length);
    await this.reservations.assertNoConflict(
      {
        seriesStartAt: new Date(data.startAt),
        intervalMinutes: data.intervalMinutes ?? null,
        firstIndex: 1,
        lastIndex: data.repeatCount,
        reservedSeconds,
      },
      await this.reservations.devicesOfTask(taskId),
    );

    return this.prisma.scheduledJob.create({
      data: {
        ...data,
        seriesStartAt: data.startAt,
        toleranceMinutes,
        reservedSeconds,
        taskId,
        createdBy: userId,
        status: 'pending',
      },
    });
  }

  async findAll(userId: string) {
    const teamWhere = await this.teamScope.projectWhereForUser(userId);

    return this.prisma.scheduledJob.findMany({
      where: { task: { project: teamWhere } },
      include: {
        task: true,
        createdByUser: {
          select: {
            uuid: true,
            email: true,
            name: true,
          },
        },
      },
      orderBy: { startAt: 'asc' },
    });
  }

  /** Choques preexistentes en los que participa al menos una serie pendiente del equipo del usuario. */
  async findConflicts(userId: string): Promise<SeriesConflictPair[]> {
    const teamWhere = await this.teamScope.projectWhereForUser(userId);
    const [pairs, mine] = await Promise.all([
      this.reservations.findConflicts(),
      this.prisma.scheduledJob.findMany({
        where: { status: 'pending', task: { project: teamWhere } },
        select: { id: true },
      }),
    ]);
    const ids = new Set(mine.map((j) => j.id));
    return pairs.filter((p) => ids.has(p.a.jobId) || ids.has(p.b.jobId));
  }

  async findOne(id: number, userId: string) {
    await this.teamScope.assertScheduledJobInTeam(userId, id);

    const job = await this.prisma.scheduledJob.findUnique({
      where: { id },
      include: {
        task: true,
        createdByUser: {
          select: {
            uuid: true,
            email: true,
            name: true,
          },
        },
      },
    });

    if (!job) {
      throw new NotFoundException(`Scheduled job with ID ${id} not found`);
    }

    return job;
  }

  async remove(id: number, userId: string) {
    await this.teamScope.assertScheduledJobInTeam(userId, id);

    const job = await this.prisma.scheduledJob.findUnique({ where: { id } });
    if (!job) {
      throw new NotFoundException(`Scheduled job with ID ${id} not found`);
    }

    if (job.status === 'running') {
      throw new BadRequestException('No se puede eliminar un job en ejecución');
    }

    return this.prisma.scheduledJob.delete({ where: { id } });
  }
}
