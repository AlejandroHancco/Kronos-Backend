import { Prisma } from '@prisma/client';
import { Injectable, HttpException, HttpStatus, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { CreateMeasurementDto } from './dto/create-measurement.dto';
import {
  channelNumbersOf,
  parseAcquisitionSnapshot,
  parseSensorValues,
  postedMeasurementError,
  storedPointsOf,
} from '@app/laas-catalog';

const decimalOrNull = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

const measurementChannelsSelect = { channelNumber: true } satisfies Prisma.MeasurementChannelSelect;

/**
 * Medición tal como la devuelve la API: copia del barrido numérica, snapshot de adquisición
 * parseado y `channels` (números de canal medidos, ascendente) a partir de `measurementChannels`
 * — cargados en la misma consulta (include/select), sin N+1. `measurementChannels` se deja tal
 * cual (puede traer metadata adicional como el alias) para no perder lo que ya exponía.
 */
function toMeasurementResponse<T extends {
  start: Prisma.Decimal | null;
  stop: Prisma.Decimal | null;
  acquisition: Prisma.JsonValue;
  measurementChannels: { channelNumber: number }[];
}>(m: T) {
  return {
    ...m,
    start: decimalOrNull(m.start),
    stop: decimalOrNull(m.stop),
    acquisition: parseAcquisitionSnapshot(m.acquisition),
    channels: channelNumbersOf(m.measurementChannels),
  };
}

@Injectable()
export class MeasurementsService {
  constructor(
      private prisma: PrismaService,
      private teamScope: TeamScopeService,
  ) {}

  async getLatest(userId: string) {
    const teamWhere = await this.teamScope.projectWhereForUser(userId);

    const latest = await this.prisma.measurement.findFirst({
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
    return latest && toMeasurementResponse(latest);
  }

  async create(createMeasurementDto: CreateMeasurementDto, userId: string) {
    await this.teamScope.assertTaskInTeam(userId, createMeasurementDto.taskId);
    const { data, sensorValues, acquisition, ...rest } = createMeasurementDto;
    const snapshot = parseAcquisitionSnapshot(acquisition);
    const payloadError = postedMeasurementError(sensorValues, data, snapshot);
    if (payloadError) throw new BadRequestException(payloadError);
    return this.prisma.measurement.create({
      data: {
        ...rest,
        sensorDeviceIp: rest.sensorDeviceIp || null,
        sensorValues: parseSensorValues(sensorValues) as unknown as Prisma.InputJsonValue,
        acquisition: snapshot as unknown as Prisma.InputJsonValue,
        // Solo { x, values } por punto (claves extra descartadas)
        data: storedPointsOf(data).map(({ x, values }) => (x === undefined ? { values } : { x, values })) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async findAll(userId: string) {
    const teamWhere = await this.teamScope.projectWhereForUser(userId);
    const rows = await this.prisma.measurement.findMany({
      where: { task: { project: teamWhere } },
      orderBy: { takenAt: 'desc' },
      include: { measurementChannels: { select: measurementChannelsSelect } },
    });
    return rows.map(toMeasurementResponse);
  }

  async findByTask(taskId: number, userId: string) {
    await this.teamScope.assertTaskInTeam(userId, taskId);
    const rows = await this.prisma.measurement.findMany({
      where: { taskId },
      orderBy: { takenAt: 'desc' },
      include: { measurementChannels: { select: measurementChannelsSelect } },
    });
    return rows.map(toMeasurementResponse);
  }

  async findOne(id: number, userId: string) {
    await this.teamScope.assertMeasurementInTeam(userId, id);
    const measurement = await this.prisma.measurement.findUnique({
      where: { id },
      include: { measurementChannels: { select: measurementChannelsSelect } },
    });

    if (!measurement) {
      return null;
    }

    return toMeasurementResponse(measurement);
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
