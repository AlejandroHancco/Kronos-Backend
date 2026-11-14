import { Prisma } from '@prisma/client';
import { Injectable, HttpException, HttpStatus, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { MeasurementsGateway } from './measurements.gateway';
import { KronosGateway } from '../gateway/kronos.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { classifyMeasurement, MeasurementClassification } from './kronos-watcher';
import { ExperimentConfigService } from '../device-plugins/core/experiment-config.service';
import { DeviceActivityService } from '../device-plugins/core/device-activity.service';
import type { MeasuredPoint } from '../device-plugins/core/device-plugin.interface';
import { requestsFor, snapshotOf, type SweepRange } from '../device-plugins/core/acquisition';
import { CreateMeasurementDto } from './dto/create-measurement.dto';
import {
  buildMeasurementData,
  ChannelResult,
  channelNumbersOf,
  parseAcquisitionSnapshot,
  parseSensorValues,
  postedMeasurementError,
  storedPointsOf,
} from './measurement-data';

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
  private readonly logger = new Logger(MeasurementsService.name);

  constructor(
      private prisma: PrismaService,
      private teamScope: TeamScopeService,
      private measurementsGateway: MeasurementsGateway,
      private kronosGateway: KronosGateway,
      private notificationsService: NotificationsService,
      private experimentConfig: ExperimentConfigService,
      private deviceActivity: DeviceActivityService,
  ) {}

  /** Notifica al equipo del resultado de una medición (según clasificación del Kronos Watcher), sin romper el flujo si falla. */
  private async notifyTeamOfMeasurementOutcome(
      userId: string,
      taskId: number,
      deviceNames: string[],
      outcome: MeasurementClassification,
  ): Promise<void> {
    try {
      const teamId = await this.teamScope.getTeamId(userId);
      const task = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { project: { select: { name: true } } },
      });
      const projectName = task?.project?.name ?? `Proyecto de la tarea ${taskId}`;

      if (outcome.severity === 'correct') {
        await this.notificationsService.notifyTeamMeasurementSuccess(teamId, projectName, deviceNames);
      } else if (outcome.severity === 'warning') {
        await this.notificationsService.notifyTeamMeasurementWarning(teamId, projectName, deviceNames, outcome.reason!);
      } else {
        await this.notificationsService.notifyTeamMeasurementFailed(teamId, projectName, deviceNames, outcome.reason!, outcome.bare);
      }
    } catch (notifyError) {
      this.logger.warn(`No se pudo notificar al equipo del resultado de la medición: ${notifyError.message}`);
    }
  }

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

  /**
   * Medir tarea completa con canales seleccionados
   * Llamado desde tasks.service con jobId para tracking WebSocket
   */
  async measureTask(
      taskId: number,
      userId: string,
      params: {
        ranges: SweepRange[];
        selectedChannels: number[];
        jobId?: string;
        scheduledJobId?: number;
        executionIndex?: number;
      },
  ) {
    const jobId = params.jobId || `${taskId}-${Date.now()}`;
    let deviceNames: string[] = [];
    let release: (() => void) | undefined;

    try {
      this.logger.log(`Starting measurement - Task: ${taskId}, JobId: ${jobId}, Ranges: ${params.ranges.length}`);

      if (!params.selectedChannels || params.selectedChannels.length === 0) {
        throw new HttpException(
            'No channels selected for this task',
            HttpStatus.BAD_REQUEST,
        );
      }

      const uniqueChannels = Array.from(new Set(params.selectedChannels)).sort(
          (a, b) => a - b,
      );

      // 1. Experimento activo (sensor + selector opcional + rango de canales) — valida canales contra lo declarado
      const resolved = await this.experimentConfig.assertChannels(taskId, uniqueChannels);
      const { preference: taskPreference, sensor, selector, channelRange, valueMetas, acquisition } = resolved;
      // 1b. Rangos de barrido contra lo que declara el sensor (frecuencia, puntos, escala)
      this.experimentConfig.assertRanges(resolved, params.ranges);
      const selectorDevice = taskPreference.channelSelectorDevice;
      const valueNames = valueMetas.map((v) => v.name);
      deviceNames = [sensor.context.name, selector?.context.name].filter((n): n is string => !!n);
      // Ocupa los dispositivos (espera a un cambio de configuración en curso) hasta terminar
      release = await this.deviceActivity.beginMeasurement([sensor.context.id, ...(selector ? [selector.context.id] : [])]);

      this.logger.log(
          `Experiment - Sensor: ${sensor.context.name} (${taskPreference.sensorDevice.type}), selector: ${selector ? `${selector.context.name} (${selector.description.deviceType})` : 'sin selector'}, canales ${channelRange.min}-${channelRange.max}, valores [${valueNames.join(', ')}]`,
      );

      this.logger.log(
          `Measuring ${uniqueChannels.length} channels × ${params.ranges.length} ranges sequentially`,
      );

      // 2. Obtener aliases configurados para los canales de esta tarea
      const taskChannels = await this.prisma.taskChannel.findMany({
        where: { taskId, channelNumber: { in: uniqueChannels } },
      });

      const aliasMap = new Map(
          taskChannels.map((tc) => [tc.channelNumber, tc.alias]),
      );

      // 3. Medir cada canal de forma SECUENCIAL.
      //    El MUX solo puede tener un canal activo a la vez —
      //    Promise.all corrupta los datos porque cambia el canal
      //    antes de que el analyzer termine de medir el anterior.
      //    Por cada canal se recorren todos los rangos secuencialmente
      //    sin cambiar el MUX entre rangos.
      const results: ChannelResult[] = [];

      for (let index = 0; index < uniqueChannels.length; index++) {
        const channel = uniqueChannels[index];

        try {
          // 3a. Activar el canal en el selector (setActuatorData) si la configuración tiene uno
          if (selector) {
            await selector.plugin.setActuatorData(selector.context, selector.actuatorId, { [selector.valueName]: channel });
          }

          // 3b. Medir todos los rangos para este canal (getSensorData del equipo de medición)
          const points: MeasuredPoint[] = [];
          for (const request of requestsFor(acquisition, params.ranges)) {
            points.push(...await sensor.plugin.getSensorData(sensor.context, request));
          }

          this.logger.log(
              `Channel ${channel} measured - ${points.length} points across ${params.ranges.length} ranges`,
          );

          results.push({ channel, points });

          // 3c. Emitir progreso DESPUÉS de medir para reflejar estado real
          const progress = Math.round(((index + 1) / uniqueChannels.length) * 100);
          this.measurementsGateway.emitMeasurementProgress(
              userId,
              jobId,
              channel,
              uniqueChannels.length,
              progress,
              `Canal ${channel} completado (${index + 1} de ${uniqueChannels.length})`,
          );

        } catch (channelError) {
          this.logger.error(
              `Error in channel ${channel}: ${channelError.message}`,
          );
          results.push({ channel, points: null });

          const progress = Math.round(((index + 1) / uniqueChannels.length) * 100);
          this.measurementsGateway.emitMeasurementProgress(
              userId,
              jobId,
              channel,
              uniqueChannels.length,
              progress,
              `Canal ${channel} falló — continuando...`,
          );
        }
      }

      // 4. Fusionar canales por x (16 slots por sensorValue declarado)
      const measurementData = buildMeasurementData(results, valueNames);

      this.logger.log(`Total points collected: ${measurementData.length}`);

      const firstRange = params.ranges[0] as SweepRange | undefined;
      const lastRange = params.ranges[params.ranges.length - 1] as SweepRange | undefined;
      const snapshot = snapshotOf(acquisition);
      const totalPoints = params.ranges.reduce((sum, r) => sum + r.points, 0);

      // 5. Clasificar con el Kronos Watcher y guardar medición en DB
      const classification = classifyMeasurement(measurementData, uniqueChannels, valueNames);
      const measurement = await this.prisma.measurement.create({
        data: {
          watcherStatus: classification.severity,
          watcherReason: classification.reason ?? null,
          taskId,
          takenBy: userId,
          scheduledJobId: params.scheduledJobId ?? null,
          executionIndex: params.executionIndex ?? null,
          presetName: taskPreference.name,
          start: firstRange?.start ?? null,
          stop: lastRange?.stop ?? null,
          points: params.ranges.length ? totalPoints : null,
          scale: firstRange?.scale ?? null,
          acquisition: snapshot as unknown as Prisma.InputJsonValue,
          sensorDeviceName: taskPreference.sensorDevice.name,
          sensorDeviceIp: taskPreference.sensorDevice.ip ?? null,
          channelSelectorName: selectorDevice?.name ?? null,
          channelSelectorIp: selectorDevice?.ip ?? null,
          sensorValues: valueMetas as unknown as Prisma.InputJsonValue,
          data: measurementData as unknown as Prisma.InputJsonValue,
        },
      });

      this.logger.log(`Measurement saved - ID: ${measurement.id}`);

      // 6. Crear MeasurementChannels usando el alias real si existe
      for (const channelNumber of uniqueChannels) {
        await this.prisma.measurementChannel.create({
          data: {
            measurementId: measurement.id,
            channelNumber,
            channelAlias: aliasMap.get(channelNumber) ?? `Canal ${channelNumber}`,
          },
        });
      }

      this.logger.log(
          `MeasurementChannels created for measurement ${measurement.id}`,
      );

      // 7. Emitir completado (sala personal del usuario + sala de la tarea)
      this.measurementsGateway.emitMeasurementCompleted(
          userId,
          jobId,
          measurement.id,
          measurement.takenAt || new Date(),
          measurementData.length,
          measurementData,
          valueMetas,
          snapshot,
          uniqueChannels,
      );

      this.kronosGateway.emitMeasurementComplete(taskId, {
        jobId,
        measurementId: measurement.id,
        takenAt: measurement.takenAt || new Date(),
        totalPoints: measurementData.length,
      });

      await this.notifyTeamOfMeasurementOutcome(userId, taskId, deviceNames, classification);

      return {
        measurementId: measurement.id,
        takenAt: measurement.takenAt || new Date(),
        totalPoints: measurementData.length,
        data: measurementData,
        sensorValues: valueMetas,
        acquisition: snapshot,
        channels: uniqueChannels,
      };

    } catch (error) {
      this.logger.error(`Measurement error: ${error.message}`);

      this.measurementsGateway.emitMeasurementError(
          userId,
          jobId,
          error.message,
      );

      await this.notifyTeamOfMeasurementOutcome(userId, taskId, deviceNames, {
        severity: 'error',
        reason: error.message,
      });

      throw error;
    } finally {
      release?.();
    }
  }

}