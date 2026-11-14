import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { CreateMeasurementDto } from './dto/create-measurement.dto';

@Injectable()
export class MeasurementsService {
  constructor(
      private prisma: PrismaService,
      private teamScope: TeamScopeService,
  ) {}

  async getLatest(userId: string) {
    const teamWhere = await this.teamScope.projectWhereForUser(userId);

    return this.prisma.measurement.findFirst({
      where: { task: { project: teamWhere } },
      orderBy: { takenAt: 'desc' },
      include: {
        task: {
          select: {
            id: true,
            name: true,
            project: { select: { uuid: true, name: true } },
          },
        },
        measurementChannels: {
          select: { channelNumber: true, channelAlias: true },
        },
      },
    });
  }

  async create(createMeasurementDto: CreateMeasurementDto, userId: string) {
    await this.teamScope.assertTaskInTeam(userId, createMeasurementDto.taskId);
    return this.prisma.measurement.create({
      data: createMeasurementDto,
    });
  }

  async findAll(userId: string) {
    const teamWhere = await this.teamScope.projectWhereForUser(userId);
    return this.prisma.measurement.findMany({
      where: { task: { project: teamWhere } },
      orderBy: { takenAt: 'desc' },
    });
  }

  async findByTask(taskId: number, userId: string) {
    await this.teamScope.assertTaskInTeam(userId, taskId);
    return this.prisma.measurement.findMany({
      where: { taskId },
      orderBy: { takenAt: 'desc' },
    });
  }

  async findOne(id: number, userId: string) {
    await this.teamScope.assertMeasurementInTeam(userId, id);
    const measurement = await this.prisma.measurement.findUnique({
      where: { id },
    });

    if (!measurement) {
      return null;
    }

    return {
      ...measurement,
      startFreq: Number(measurement.startFreq),
      stopFreq:  Number(measurement.stopFreq),
    };
  }

  async remove(id: number, userId: string) {
    await this.teamScope.assertMeasurementInTeam(userId, id);
    return this.prisma.measurement.delete({
      where: { id },
    });
  }

  /**
   * Actualizar metadata del canal en una medicion
   * PATCH /measurements/:id/channels/:channelNumber
   */
  async updateMeasurementChannelMetadata(
      measurementId: number,
      channelNumber: number,
      userId: string,
      updateData: {
        concreteMix?: number;
        hasEmulsifier?: boolean;
        notes?: string;
        sampleAge?: number;
        temperature?: number;
        humidity?: number;
      },
  ) {
    await this.teamScope.assertMeasurementInTeam(userId, measurementId);
    const measurementChannel = await this.prisma.measurementChannel.findUnique({
      where: {
        measurementId_channelNumber: { measurementId, channelNumber },
      },
    });

    if (!measurementChannel) {
      throw new HttpException(
          `MeasurementChannel not found: measurement ${measurementId}, channel ${channelNumber}`,
          HttpStatus.NOT_FOUND,
      );
    }

    return this.prisma.measurementChannel.update({
      where: { id: measurementChannel.id },
      data: updateData,
    });
  }
}
