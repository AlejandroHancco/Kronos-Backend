import { Prisma } from '@prisma/client';
import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { RealtimePublisher } from '@app/realtime';
import { NotificationWriter } from '@app/notifications';
import { DeviceDriverRegistry } from '@app/device-drivers';
import { ExperimentConfigService } from '@app/experiments';
import {
  buildMeasurementData,
  requestsFor,
  snapshotOf,
  type ChannelResult,
  type MeasuredPoint,
  type SweepRange,
} from '@app/laas-catalog';
import { classifyMeasurement, MeasurementClassification } from './kronos-watcher';

@Injectable()
export class MeasurementExecutor {
  private readonly logger = new Logger(MeasurementExecutor.name);

  constructor(
      private prisma: PrismaService,
      private teamScope: TeamScopeService,
      private realtime: RealtimePublisher,
      private notifications: NotificationWriter,
      private experimentConfig: ExperimentConfigService,
      private drivers: DeviceDriverRegistry,
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
        await this.notifications.notifyTeamMeasurementSuccess(teamId, projectName, deviceNames);
      } else if (outcome.severity === 'warning') {
        await this.notifications.notifyTeamMeasurementWarning(teamId, projectName, deviceNames, outcome.reason!);
      } else {
        await this.notifications.notifyTeamMeasurementFailed(teamId, projectName, deviceNames, outcome.reason!, outcome.bare);
      }
    } catch (notifyError) {
      this.logger.warn(`No se pudo notificar al equipo del resultado de la medición: ${notifyError.message}`);
    }
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
      const sensorDriver = this.drivers.sensor(taskPreference.sensorDevice.type);
      const selectorDriver = selector ? this.drivers.actuator(selectorDevice?.type) : null;
      const valueNames = valueMetas.map((v) => v.name);
      deviceNames = [sensor.context.name, selector?.context.name].filter((n): n is string => !!n);

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
            await selectorDriver!.setActuatorData(selector.context, selector.actuatorId, { [selector.valueName]: channel });
          }

          // 3b. Medir todos los rangos para este canal (getSensorData del equipo de medición)
          const points: MeasuredPoint[] = [];
          for (const request of requestsFor(acquisition, params.ranges)) {
            points.push(...await sensorDriver.getSensorData(sensor.context, request));
          }

          this.logger.log(
              `Channel ${channel} measured - ${points.length} points across ${params.ranges.length} ranges`,
          );

          results.push({ channel, points });

          // 3c. Emitir progreso DESPUÉS de medir para reflejar estado real
          const progress = Math.round(((index + 1) / uniqueChannels.length) * 100);
          this.realtime.measurementProgress(
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
          this.realtime.measurementProgress(
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
      this.realtime.measurementCompleted(
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

      this.realtime.measurementComplete(taskId, {
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

      this.realtime.measurementError(
          userId,
          jobId,
          error.message,
      );

      await this.notifyTeamOfMeasurementOutcome(userId, taskId, deviceNames, {
        severity: 'error',
        reason: error.message,
      });

      throw error;
    }
  }
}
