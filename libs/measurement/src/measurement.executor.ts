import { Injectable, HttpException, HttpStatus, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { RealtimePublisher } from '@app/realtime';
import { NotificationWriter } from '@app/notifications';
import { DevicePluginRegistry } from '@app/device-plugins';
import { classifyMeasurement, MeasurementClassification } from './kronos-watcher';

export interface MeasurementRange {
  startFreq: number;
  stopFreq: number;
  points: number;
  sweepType: 'LOG' | 'LIN';
}

@Injectable()
export class MeasurementExecutor {
  private readonly logger = new Logger(MeasurementExecutor.name);

  constructor(
      private prisma: PrismaService,
      private teamScope: TeamScopeService,
      private realtime: RealtimePublisher,
      private notifications: NotificationWriter,
      private devicePlugins: DevicePluginRegistry,
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
        ranges: MeasurementRange[];
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

      if (!params.ranges || params.ranges.length === 0) {
        throw new HttpException(
            'No frequency ranges specified',
            HttpStatus.BAD_REQUEST,
        );
      }

      const uniqueChannels = Array.from(new Set(params.selectedChannels)).sort(
          (a, b) => a - b,
      );

      // 1. Obtener task_preference activa
      const taskPreference = await this.prisma.taskPreference.findFirst({
        where: { taskId },
        orderBy: { createdAt: 'desc' },
        include: {
          analyzerDevice: true,
          muxDevice: true,
        },
      });

      if (!taskPreference) {
        throw new BadRequestException(
            'Esta tarea no tiene un analizador y un MUX asignados. Configúralos antes de medir.',
        );
      }

      deviceNames = [taskPreference.analyzerDevice.name, taskPreference.muxDevice.name].filter(Boolean);

      // Resuelve el plugin según el tipo del analyzer (device.type) — el Kronos Watcher
      // no sabe (ni necesita saber) que hoy es un Hioki IM3570.
      const plugin = this.devicePlugins.get(taskPreference.analyzerDevice.type);

      this.logger.log(
          `Preference found - Analyzer: ${taskPreference.analyzerDevice.ip}:3570, MUX: ${taskPreference.muxDevice.ip}`,
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

      // 3. Inicializar datos
      const allData = new Map<number, { g: number[]; b: number[] }>();

      // 4. Medir cada canal de forma SECUENCIAL.
      //    El MUX solo puede tener un canal activo a la vez —
      //    Promise.all corrupta los datos porque cambia el canal
      //    antes de que el analyzer termine de medir el anterior.
      //    Por cada canal se recorren todos los rangos secuencialmente
      //    sin cambiar el MUX entre rangos.
      const results: { channel: number; channelData: Array<[number, number, number]> | null }[] = [];

      for (let index = 0; index < uniqueChannels.length; index++) {
        const channel = uniqueChannels[index];

        try {
          // 4a. Cambiar canal en MUX una sola vez por canal
          await plugin.selectChannel(taskPreference.muxDevice.ip ?? '', channel);

          // 4b. Medir todos los rangos para este canal
          const channelData: Array<[number, number, number]> = [];
          for (const range of params.ranges) {
            const rangeData = await plugin.measureChannel({
              analyzerIp: taskPreference.analyzerDevice.ip ?? '',
              startFreq: range.startFreq,
              stopFreq: range.stopFreq,
              points: range.points,
              sweepType: range.sweepType,
            });
            channelData.push(
                ...rangeData.map(
                    (p): [number, number, number] => [p.frequency, p.values.g ?? 0, p.values.b ?? 0],
                ),
            );
          }

          this.logger.log(
              `Channel ${channel} measured - ${channelData.length} points across ${params.ranges.length} ranges`,
          );

          results.push({ channel, channelData });

          // 4c. Emitir progreso DESPUÉS de medir para reflejar estado real
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
          results.push({ channel, channelData: null });

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

      // 5. Procesar resultados
      for (const { channel, channelData } of results) {
        if (!channelData) continue;

        for (const [freq, gValue, bValue] of channelData) {
          if (!allData.has(freq)) {
            allData.set(freq, {
              g: Array(16).fill(0),
              b: Array(16).fill(0),
            });
          }
          const data = allData.get(freq)!;
          data.g[channel - 1] = gValue;
          data.b[channel - 1] = bValue;
        }
      }

      // 6. Construir array JSONB final ordenado por frecuencia
      const measurementData = Array.from(allData.entries())
          .sort(([freqA], [freqB]) => freqA - freqB)
          .map(([frequency, vals]) => ({
            frequency,
            g: vals.g,
            b: vals.b,
          }));

      this.logger.log(`Total points collected: ${measurementData.length}`);

      const firstRange = params.ranges[0];
      const lastRange = params.ranges[params.ranges.length - 1];
      const totalPoints = params.ranges.reduce((sum, r) => sum + r.points, 0);

      // 7. Clasificar con el Kronos Watcher y guardar medición en DB
      const classification = classifyMeasurement(measurementData, uniqueChannels);
      const measurement = await this.prisma.measurement.create({
        data: {
          watcherStatus: classification.severity,
          watcherReason: classification.reason ?? null,
          taskId,
          takenBy: userId,
          scheduledJobId: params.scheduledJobId ?? null,
          executionIndex: params.executionIndex ?? null,
          presetName: taskPreference.name,
          startFreq: firstRange.startFreq,
          stopFreq: lastRange.stopFreq,
          points: totalPoints,
          sweepType: firstRange.sweepType,
          analyzerName: taskPreference.analyzerDevice.name,
          analyzerIp: taskPreference.analyzerDevice.ip ?? '',
          muxName: taskPreference.muxDevice.name,
          muxIp: taskPreference.muxDevice.ip ?? '',
          data: measurementData,
        } as any,
      });

      this.logger.log(`Measurement saved - ID: ${measurement.id}`);

      // 8. Crear MeasurementChannels usando el alias real si existe
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

      // 9. Emitir completado (sala personal del usuario + sala de la tarea)
      this.realtime.measurementCompleted(
          userId,
          jobId,
          measurement.id,
          measurement.takenAt || new Date(),
          measurementData.length,
          measurementData,
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
