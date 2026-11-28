import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Prisma, ScheduledJob } from '@prisma/client';
import { PrismaService, deviceIdsOf, runningJobDeviceIds } from '@app/database';
import { ExperimentConfigService, ResolvedExperiment, toSweepRanges } from '@app/experiments';
import type { SweepRange } from '@app/laas-catalog';
import {
  MissReason,
  SeriesReservationsService,
  estimateSeconds,
  nextReservationStart,
  occurrenceStart,
  toleranceWindowEnd,
} from '@app/measurement';
import { RealtimePublisher } from '@app/realtime';
import { RedisLockService } from '@app/redis';
import { MEASUREMENTS_QUEUE, MeasurementJobData, PRIORITY_SCHEDULED } from '@app/queue';

/** Cada cuánto corre el tick. */
const TICK_MS = 10_000;
/** TTL del liderazgo; menor que el tick y no se libera al terminar (el TTL cierra el turno). */
const LEADER_TTL_MS = 8_000;
/** Un job se publica en Bull (diferido) cuando le faltan como mucho estos ms para empezar. */
const ENQUEUE_LEAD_MS = 30_000;
/**
 * Si la ventana de un pending cerró hace más que esto, ningún tick la vio cerrarse
 * (scheduler caído o atascado): se registra system_down y se recupera la rejilla.
 */
const SYSTEM_DOWN_AFTER_MS = 2 * TICK_MS;

/** Campos de una fila de la cadena que el scheduler necesita. */
type ChainJob = Pick<
  ScheduledJob,
  | 'id'
  | 'taskId'
  | 'createdBy'
  | 'label'
  | 'startAt'
  | 'intervalMinutes'
  | 'repeatCount'
  | 'executionIndex'
  | 'seriesStartAt'
  | 'toleranceMinutes'
  | 'reservedSeconds'
  | 'channelNumbers'
>;

type Estimate = { resolved: ResolvedExperiment; ranges: SweepRange[]; estimatedSeconds: number };

/**
 * Despacha los ScheduledJobs con rejilla fija. Corre cada 10 s, solo en la réplica que obtiene el
 * liderazgo (lock Redis 'scheduler'):
 *  - Un pending a ≤ 30 s de su startAt con los dispositivos libres y online se marca 'running' y se
 *    publica como job Bull diferido (delay = startAt − now, jobId `scheduled-<id>`), para que empiece
 *    puntual y no al siguiente tick.
 *  - Vencido y no despachable (dispositivo ocupado u offline): espera mientras siga dentro de su
 *    ventana (startAt + tolerancia + 30 s) y la próxima reserva de sus dispositivos le deje terminar;
 *    si no, pasa a 'missed' con el motivo.
 *  - La siguiente repetición siempre va a seriesStartAt + executionIndex × intervalo (rejilla, nunca
 *    now + intervalo), al publicar o al perder la actual; una fila por punto (índice único).
 *  - Tras una caída, los puntos cuya ventana ya pasó quedan 'missed' (system_down) y la serie sigue
 *    en el primer punto con ventana abierta.
 *  - Errores de configuración (sin canales, sin equipo, rangos inválidos) ⇒ 'failed', como antes.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);
  private ticking = false; // evita solapamiento de ticks

  constructor(
    private prisma: PrismaService,
    private experimentConfig: ExperimentConfigService,
    private realtime: RealtimePublisher,
    private lockService: RedisLockService,
    @InjectQueue(MEASUREMENTS_QUEUE)
    private measurementQueue: Queue<MeasurementJobData>,
    private reservations: SeriesReservationsService,
  ) {}

  @Interval(TICK_MS)
  async processPendingJobs() {
    if (this.ticking) return;
    this.ticking = true;

    try {
      await this.lockService.runAsLeader('scheduler', LEADER_TTL_MS, () => this.tick());
    } catch (error) {
      this.logger.error(`Scheduler tick failed: ${error.message}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Marca el job 'missed' (si sigue pending o running) con el motivo y crea la siguiente repetición
   * en la rejilla. Idempotente: si ya estaba resuelto no hace nada.
   */
  async markMissed(jobId: number, reason: MissReason): Promise<void> {
    const job = await this.prisma.scheduledJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    await this.missJob(job, reason);
  }

  private async tick(): Promise<void> {
    const now = new Date();

    const candidates = await this.prisma.scheduledJob.findMany({
      where: { status: 'pending', startAt: { lte: new Date(now.getTime() + ENQUEUE_LEAD_MS) } },
      orderBy: { startAt: 'asc' },
    });
    if (candidates.length === 0) return;

    // Dispositivos ocupados por jobs en ejecución (se amplía con los que se publican en este tick)
    const busyDevices = await runningJobDeviceIds(this.prisma);

    for (const job of candidates) {
      try {
        await this.processJob(job, now, busyDevices);
      } catch (error) {
        // Un job que falla no detiene el despacho de los demás en este tick
        this.logger.error(`Job ${job.id}: error al despachar: ${error.message}`);
      }
    }
  }

  private async processJob(job: ChainJob, now: Date, busyDevices: Set<string>): Promise<void> {
    const windowEnd = toleranceWindowEnd(job.startAt, job.toleranceMinutes);

    if (now.getTime() - windowEnd.getTime() > SYSTEM_DOWN_AFTER_MS) {
      const open = await this.catchUp(job, now);
      // el primer punto abierto puede estar ya dentro de su ventana: se atiende en este mismo tick
      if (open && open.startAt.getTime() <= now.getTime() + ENQUEUE_LEAD_MS) {
        await this.processJob(open, now, busyDevices);
      }
      return;
    }

    if (job.channelNumbers.length === 0) {
      await this.failJob(job.id, 'no tiene canales seleccionados');
      return;
    }

    // Resolver el experimento y validar los rangos ANTES de reclamar el job: si algo falla el job
    // pasa a 'failed' y nunca queda 'running' bloqueando sus dispositivos.
    let estimate: Estimate | null;
    try {
      estimate = await this.resolveWithEstimate(job.taskId, job.channelNumbers.length);
    } catch (error) {
      await this.failJob(job.id, error.message);
      return;
    }
    if (!estimate) {
      await this.failJob(job.id, 'la tarea no tiene un equipo de medición asignado');
      return;
    }

    const devices = deviceIdsOf(estimate.resolved.preference);
    const busy = devices.some((id) => busyDevices.has(id));
    const offline = await this.anyOffline(devices);

    if (!busy && !offline && now <= windowEnd) {
      await this.enqueue(job, now, estimate, devices, busyDevices);
      return;
    }
    if (job.startAt > now) return; // aún no empieza: lo reintenta el siguiente tick

    const reason = await this.missReason(job, now, windowEnd, estimate.estimatedSeconds, devices, busy, offline);
    if (!reason) {
      this.logger.log(`Job ${job.id} en espera — dispositivo ${offline ? 'offline' : 'ocupado'}, dentro de su ventana`);
      return;
    }
    await this.missJob(job, reason);
  }

  /**
   * null mientras pueda esperar: dentro de la ventana y `now + estimación ≤` próxima reserva de sus
   * dispositivos (sin contar su propia cadena). Si no, el motivo según el límite que cerró primero.
   */
  private async missReason(
    job: ChainJob,
    now: Date,
    windowEnd: Date,
    estimatedSeconds: number,
    devices: string[],
    busy: boolean,
    offline: boolean,
  ): Promise<MissReason | null> {
    const projectId = await this.reservations.projectOfTask(job.taskId);
    const series = await this.reservations.seriesForDevices(devices, [job.id], projectId ?? undefined);
    // reservas que empiezan después del inicio planificado: si alguna ya empezó, el hueco se perdió
    const next = nextReservationStart(series, job.startAt);
    const slotCloseAt = next ? next.getTime() - estimatedSeconds * 1000 : Infinity;
    const slotOk = now.getTime() <= slotCloseAt;
    const windowOk = now <= windowEnd;
    if (slotOk && windowOk) return null;
    if (offline) return 'device_offline';
    if (!slotOk && slotCloseAt < windowEnd.getTime()) return 'no_slot';
    return busy ? 'device_busy' : 'tolerance_exceeded';
  }

  /** Marca 'running', publica el job Bull diferido y crea la siguiente repetición. */
  private async enqueue(job: ChainJob, now: Date, estimate: Estimate, devices: string[], busyDevices: Set<string>) {
    const claimed = await this.prisma.scheduledJob.updateMany({
      where: { id: job.id, status: 'pending' },
      data: { status: 'running' },
    });
    if (claimed.count === 0) return; // otro proceso lo tomó

    devices.forEach((id) => busyDevices.add(id));

    const jobId = `scheduled-${job.id}`;
    const payload: MeasurementJobData = {
      taskId: job.taskId,
      userId: job.createdBy,
      ranges: estimate.ranges,
      selectedChannels: job.channelNumbers,
      jobId,
      estimatedSeconds: estimate.estimatedSeconds,
      scheduledJobId: job.id,
      executionIndex: job.executionIndex,
      plannedAt: job.startAt.toISOString(),
      toleranceMinutes: job.toleranceMinutes,
    };
    const delay = Math.max(0, job.startAt.getTime() - now.getTime());

    try {
      await this.measurementQueue.add('execute', payload, {
        jobId, // determinista: Bull ignora un segundo add del mismo job
        delay,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 100,
        priority: PRIORITY_SCHEDULED, // por delante de las mediciones manuales
      });
    } catch (error) {
      // no quedó publicado: vuelve a pending para que lo reintente el siguiente tick
      await this.prisma.scheduledJob.updateMany({
        where: { id: job.id, status: 'running' },
        data: { status: 'pending' },
      });
      devices.forEach((id) => busyDevices.delete(id));
      throw error;
    }
    this.logger.log(`Job ${job.id} publicado (execution ${job.executionIndex}, empieza en ${delay} ms)`);

    this.realtime.jobStatus(job.createdBy, { jobId, taskId: job.taskId, status: 'queued' });

    await this.createNext(job);
  }

  /**
   * Recuperación tras caída: el job y cada punto siguiente cuya ventana ya pasó quedan 'missed'
   * (system_down, una fila por punto); devuelve el pending creado en el primer punto con ventana
   * abierta (null si la cadena se agotó o el job ya lo resolvió otro proceso).
   */
  private async catchUp(job: ChainJob, now: Date): Promise<ChainJob | null> {
    if (!(await this.setMissed(job.id, 'system_down'))) return null;
    if (!job.intervalMinutes) return null;

    const missed: Prisma.ScheduledJobCreateManyInput[] = [];
    let openIndex: number | null = null;
    // como mucho repeatCount − 1 puntos más (los que le quedan a la cadena)
    for (let idx = job.executionIndex + 1; idx < job.executionIndex + job.repeatCount; idx++) {
      if (now > toleranceWindowEnd(occurrenceStart(job, idx), job.toleranceMinutes)) {
        missed.push({ ...this.chainRow(job, idx), status: 'missed', missReason: 'system_down' });
      } else {
        openIndex = idx;
        break;
      }
    }
    if (missed.length > 0) {
      await this.prisma.scheduledJob.createMany({ data: missed, skipDuplicates: true });
    }
    this.logger.warn(
      `Job ${job.id}: ${missed.length + 1} punto(s) perdido(s) por caída del scheduler (system_down)` +
        (openIndex ? `; la serie sigue en la ejecución ${openIndex}` : '; serie agotada'),
    );
    return openIndex ? this.createPending(job, openIndex) : null;
  }

  private async missJob(job: ChainJob, reason: MissReason): Promise<void> {
    if (!(await this.setMissed(job.id, reason))) return;
    await this.createNext(job);
  }

  /** true si el job pasó a 'missed' (seguía pending o running). */
  private async setMissed(jobId: number, reason: MissReason): Promise<boolean> {
    const updated = await this.prisma.scheduledJob.updateMany({
      where: { id: jobId, status: { in: ['pending', 'running'] } },
      data: { status: 'missed', missReason: reason },
    });
    if (updated.count > 0) this.logger.warn(`Job ${jobId} marcado como missed: ${reason}`);
    return updated.count > 0;
  }

  /** Siguiente repetición en la rejilla, si quedan. */
  private async createNext(job: ChainJob): Promise<ChainJob | null> {
    if (!job.intervalMinutes || job.repeatCount <= 1) return null;
    return this.createPending(job, job.executionIndex + 1);
  }

  /** Crea el pending del punto `idx` de la cadena; null si ya existía (P2002: reinicio / otro proceso). */
  private async createPending(job: ChainJob, idx: number): Promise<ChainJob | null> {
    try {
      const next = await this.prisma.scheduledJob.create({ data: { ...this.chainRow(job, idx), status: 'pending' } });
      this.logger.log(
        `Siguiente ejecución programada: job ${next.id} a las ${next.startAt.toISOString()} (${next.repeatCount} restante(s))`,
      );
      return next;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    }
  }

  /** Fila del punto `idx` de la misma cadena (startAt en la rejilla, repeticiones restantes incluida esta). */
  private chainRow(job: ChainJob, idx: number) {
    return {
      taskId: job.taskId,
      createdBy: job.createdBy,
      label: job.label,
      startAt: occurrenceStart(job, idx),
      intervalMinutes: job.intervalMinutes,
      repeatCount: job.repeatCount - (idx - job.executionIndex),
      executionIndex: idx,
      seriesStartAt: job.seriesStartAt,
      toleranceMinutes: job.toleranceMinutes,
      reservedSeconds: job.reservedSeconds,
      channelNumbers: job.channelNumbers,
    };
  }

  private async anyOffline(deviceIds: string[]): Promise<boolean> {
    const devices = await this.prisma.device.findMany({
      where: { id: { in: deviceIds } },
      select: { id: true, status: true },
    });
    return devices.some((d) => d.status === 'offline');
  }

  /**
   * Experimento activo + rangos guardados + duración estimada (null = sin equipo de medición).
   * Los BadRequestException de resolve/assertRanges se propagan.
   */
  private async resolveWithEstimate(taskId: number, channelCount: number): Promise<Estimate | null> {
    const resolved = await this.experimentConfig.resolve(taskId);
    if (!resolved) return null;
    const ranges = toSweepRanges(resolved.preference.ranges);
    this.experimentConfig.assertRanges(resolved, ranges);
    const estimatedSeconds = estimateSeconds(resolved.acquisition, ranges, channelCount, !!resolved.selector);
    return { resolved, ranges, estimatedSeconds };
  }

  /** Marca un job pendiente como 'failed' registrando el motivo. */
  private async failJob(jobId: number, reason: string) {
    this.logger.warn(`Job ${jobId} marcado como failed: ${reason}`);
    await this.prisma.scheduledJob.update({
      where: { id: jobId },
      data: { status: 'failed' },
    });
  }
}
