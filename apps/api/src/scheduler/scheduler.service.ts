import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { PrismaService } from '@app/database';
import { ExperimentConfigService } from '@app/experiments';
import { RealtimePublisher } from '@app/realtime';
import { MEASUREMENTS_QUEUE, MeasurementJobData, PRIORITY_SCHEDULED } from '@app/queue';
import { MeasurementSchedulingService, ExecutionEstimate } from './scheduling.service';
import { deviceIdsOf, runningJobDeviceIds } from './device-usage';

/**
 * Cron que despacha los ScheduledJobs pendientes.
 * Corre cada minuto:
 *  1. Busca jobs 'pending' con startAt <= ahora
 *  2. Resuelve el experimento y valida los rangos (solo barridos); si falla, el job pasa a 'failed'
 *  3. Salta los que usan un dispositivo (equipo de medición / selector de canal) ya ocupado por un job 'running'
 *  4. Marca el job como 'running' y lo publica en la cola Bull 'measurements' con prioridad alta
 *  5. Si tiene intervalMinutes y quedan repeticiones, crea el siguiente job
 *     con startAt = ahora + intervalMinutes y repeatCount - 1
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private ticking = false; // evita solapamiento de ticks del cron

  constructor(
    private prisma: PrismaService,
    private schedulingService: MeasurementSchedulingService,
    private realtime: RealtimePublisher,
    @InjectQueue(MEASUREMENTS_QUEUE)
    private measurementQueue: Queue<MeasurementJobData>,
    private experimentConfig: ExperimentConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processPendingJobs() {
    if (this.ticking) return;
    this.ticking = true;

    try {
      const now = new Date();

      // 1. Jobs pendientes cuyo startAt ya venció
      const dueJobs = await this.prisma.scheduledJob.findMany({
        where: { status: 'pending', startAt: { lte: now } },
        orderBy: { startAt: 'asc' },
      });

      if (dueJobs.length === 0) return;

      this.logger.log(`${dueJobs.length} scheduled job(s) due`);

      // 2. Dispositivos ocupados por jobs actualmente en ejecución
      const busyDevices = await this.getBusyDeviceIds();

      for (const job of dueJobs) {
        try {
          await this.dispatchJob(job, now, busyDevices);
        } catch (error) {
          // Un job que falla no detiene el despacho de los demás en este tick
          this.logger.error(`Job ${job.id}: error al despachar: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Scheduler tick failed: ${error.message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** IDs de dispositivos (equipo de medición + selector de canal) usados por jobs con status 'running' */
  private getBusyDeviceIds(): Promise<Set<string>> {
    return runningJobDeviceIds(this.prisma);
  }

  /** Marca un job pendiente como 'failed' registrando el motivo. */
  private async failJob(jobId: number, reason: string) {
    this.logger.warn(`Job ${jobId} marcado como failed: ${reason}`);
    await this.prisma.scheduledJob.update({
      where: { id: jobId },
      data: { status: 'failed' },
    });
  }

  private async dispatchJob(
    job: {
      id: number;
      taskId: number;
      createdBy: string;
      label: string | null;
      intervalMinutes: number | null;
      repeatCount: number;
      executionIndex: number;
      channelNumbers: number[];
    },
    now: Date,
    busyDevices: Set<string>,
  ) {
    if (job.channelNumbers.length === 0) {
      await this.failJob(job.id, 'no tiene canales seleccionados');
      return;
    }

    // 1. Resolver el experimento y validar los rangos guardados ANTES de reclamar el job:
    //    si algo falla aquí el job pasa a 'failed' y nunca queda 'running' bloqueando sus dispositivos.
    //    Los rangos solo se exigen a sensores de barrido; una lectura puntual no lleva rangos.
    let estimate: ExecutionEstimate | null;
    try {
      estimate = await this.schedulingService.resolveWithEstimate(job.taskId, job.channelNumbers.length);
      if (estimate) this.experimentConfig.assertRanges(estimate.resolved, estimate.ranges);
    } catch (error) {
      await this.failJob(job.id, error.message);
      return;
    }
    if (!estimate) {
      await this.failJob(job.id, 'la tarea no tiene un equipo de medición asignado');
      return;
    }
    const { resolved, ranges, estimatedSeconds } = estimate;

    // 2. Conflicto de dispositivos: otro job corriendo usa el mismo equipo de medición o selector de canal
    if (deviceIdsOf(resolved.preference).some((id) => busyDevices.has(id))) {
      this.logger.log(
        `Job ${job.id} pospuesto — dispositivo ocupado por otro job en ejecución`,
      );
      return; // queda 'pending'; se reintenta en el próximo tick
    }

    // 3. Marcar como running (guard de idempotencia: solo si sigue pending)
    const claimed = await this.prisma.scheduledJob.updateMany({
      where: { id: job.id, status: 'pending' },
      data: { status: 'running' },
    });
    if (claimed.count === 0) return; // otro proceso lo tomó

    // Reservar los devices para el resto del tick
    deviceIdsOf(resolved.preference).forEach((id) => busyDevices.add(id));

    const payload: MeasurementJobData = {
      taskId: job.taskId,
      userId: job.createdBy,
      ranges,
      selectedChannels: job.channelNumbers,
      jobId: `scheduled-${job.id}`,
      estimatedSeconds,
      scheduledJobId: job.id,
      executionIndex: job.executionIndex,
    };

    // 4. Publicar en la cola Bull con prioridad alta
    await this.measurementQueue.add('execute', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 100,
      priority: PRIORITY_SCHEDULED, // por delante de las mediciones manuales
    });
    this.logger.log(`Job ${job.id} publicado en la cola (execution ${job.executionIndex})`);

    this.realtime.jobStatus(job.createdBy, {
      jobId: `scheduled-${job.id}`,
      taskId: job.taskId,
      status: 'processing',
    });

    // 5/6. Programar la siguiente repetición si corresponde
    if (job.intervalMinutes && job.repeatCount > 1) {
      const nextStartAt = new Date(now.getTime() + job.intervalMinutes * 60_000);
      const next = await this.prisma.scheduledJob.create({
        data: {
          taskId: job.taskId,
          createdBy: job.createdBy,
          label: job.label,
          startAt: nextStartAt,
          intervalMinutes: job.intervalMinutes,
          repeatCount: job.repeatCount - 1,       // repeticiones restantes
          executionIndex: job.executionIndex + 1, // posición en la cadena
          channelNumbers: job.channelNumbers,
          status: 'pending',
        },
      });
      this.logger.log(
        `Siguiente ejecución programada: job ${next.id} a las ${nextStartAt.toISOString()} ` +
        `(${next.repeatCount} restante(s))`,
      );
    }
  }
}
