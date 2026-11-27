import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { deviceIdsOf, PrefDevices, PrismaService } from '@app/database';
import { ExperimentConfigService, toSweepRanges } from '@app/experiments';
import { estimateSeconds } from './estimate';
import { SeriesWindow, firstOverlap, reservedSecondsFor, selfOverlaps, suggestStart } from './series';

/** Cadena pendiente (el job pendiente cubre executionIndex..executionIndex+repeatCount−1) con su reserva. */
export type ReservedSeries = SeriesWindow & { jobId: number; taskId: number; taskName: string; label: string | null };

export interface SeriesConflict {
  jobId: number;
  taskName: string;
  label: string | null;
  at: string;
}

export interface SeriesConflictPair {
  a: { jobId: number; taskName: string };
  b: { jobId: number; taskName: string };
  at: string;
}

export interface ReservedSecondsUpdate {
  jobId: number;
  reservedSeconds: number;
}

/** Cuántas duraciones reales recientes cuentan para la reserva. */
const RECENT_DURATIONS = 5;

export const SERIES_CONFLICT_MESSAGE = 'La serie choca con otra medición programada en el mismo equipo';

const pendingChainSelect = {
  id: true,
  taskId: true,
  label: true,
  seriesStartAt: true,
  intervalMinutes: true,
  executionIndex: true,
  repeatCount: true,
  reservedSeconds: true,
  task: { select: { name: true } },
} as const;

type PendingChainRow = {
  id: number;
  seriesStartAt: Date;
  intervalMinutes: number | null;
  executionIndex: number;
  repeatCount: number;
  reservedSeconds: number;
};

/** Ventana de reservas de una cadena pendiente. */
export function windowOf(job: PendingChainRow): SeriesWindow {
  return {
    seriesStartAt: job.seriesStartAt,
    intervalMinutes: job.intervalMinutes,
    firstIndex: job.executionIndex,
    lastIndex: job.executionIndex + job.repeatCount - 1,
    reservedSeconds: job.reservedSeconds,
  };
}

/** 400 si la serie choca consigo misma (intervalo < reserva con más de una ocurrencia). */
export function assertNoSelfOverlap(candidate: SeriesWindow): void {
  if (selfOverlaps(candidate)) {
    throw new BadRequestException(
      `El intervalo es menor que la duración reservada de cada medición (${Math.ceil(candidate.reservedSeconds / 60)} min)`,
    );
  }
}

/**
 * Reservas de dispositivos de las series programadas: cada ocurrencia ocupa los dispositivos de
 * su tarea (sensor + selector de la preferencia más reciente) durante `reservedSeconds`.
 * La comparten la API (admisión al programar / cambiar configuración) y el worker.
 */
@Injectable()
export class SeriesReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly experimentConfig: ExperimentConfigService,
  ) {}

  /** Dispositivos de la tarea: sensor + selector de su TaskPreference más reciente ([] sin preferencia). */
  async devicesOfTask(taskId: number): Promise<string[]> {
    const pref = await this.prisma.taskPreference.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      select: { sensorDeviceId: true, channelSelectorDeviceId: true },
    });
    return pref ? deviceIdsOf(pref) : [];
  }

  /** Una entrada por cadena pendiente cuya tarea usa alguno de `deviceIds`. */
  async seriesForDevices(deviceIds: string[], excludeJobIds: number[] = []): Promise<ReservedSeries[]> {
    if (deviceIds.length === 0) return [];
    const wanted = new Set(deviceIds);
    const all = await this.pendingSeries(excludeJobIds);
    return all.filter((s) => s.devices.some((d) => wanted.has(d))).map(({ devices: _d, ...s }) => s);
  }

  /** Reserva (s) de una ejecución de la tarea con `channelCount` canales, con su configuración actual. */
  async reservedSecondsForTask(taskId: number, channelCount: number): Promise<number> {
    const resolved = await this.experimentConfig.resolve(taskId);
    if (!resolved) {
      throw new BadRequestException('Esta tarea no tiene un equipo de medición asignado. Configúralo antes de medir.');
    }
    const estimate = estimateSeconds(
      resolved.acquisition,
      toSweepRanges(resolved.preference.ranges),
      channelCount,
      !!resolved.selector,
    );
    return reservedSecondsFor(estimate, await this.recentDurations(taskId));
  }

  /**
   * 400 si la serie se solapa consigo misma; 409 `{ message, conflicts, suggestedStartAt }` si alguna
   * ocurrencia se solapa con una cadena pendiente que comparte dispositivo.
   */
  async assertNoConflict(candidate: SeriesWindow, deviceIds: string[], excludeJobIds: number[] = []): Promise<void> {
    assertNoSelfOverlap(candidate);
    this.assertAgainst(candidate, await this.seriesForDevices(deviceIds, excludeJobIds));
  }

  /**
   * Revalida las cadenas pendientes de la tarea con una nueva configuración (dispositivos y
   * estimación por nº de canales) contra las cadenas de otras tareas. Lanza 400/409 como
   * assertNoConflict; si todo cabe devuelve el nuevo reservedSeconds de cada cadena (sin guardarlo:
   * ver applyReservedSeconds). Sin cadenas pendientes devuelve [] sin más consultas.
   */
  async revalidateTask(
    taskId: number,
    deviceIds: string[],
    estimateFor: (channelCount: number) => number,
  ): Promise<ReservedSecondsUpdate[]> {
    const own = await this.prisma.scheduledJob.findMany({
      where: { taskId, status: 'pending' },
      select: { ...pendingChainSelect, channelNumbers: true },
      orderBy: { startAt: 'asc' },
    });
    if (own.length === 0) return [];
    const durations = await this.recentDurations(taskId);
    const others = await this.seriesForDevices(deviceIds, own.map((j) => j.id));
    return own.map((j) => {
      const reservedSeconds = reservedSecondsFor(estimateFor(j.channelNumbers.length), durations);
      const candidate = { ...windowOf(j), reservedSeconds };
      assertNoSelfOverlap(candidate);
      this.assertAgainst(candidate, others);
      return { jobId: j.id, reservedSeconds };
    });
  }

  /** Guarda reservedSeconds en las cadenas (solo si siguen pendientes). */
  async applyReservedSeconds(updates: ReservedSecondsUpdate[]): Promise<void> {
    const byValue = new Map<number, number[]>();
    for (const u of updates) byValue.set(u.reservedSeconds, [...(byValue.get(u.reservedSeconds) ?? []), u.jobId]);
    for (const [reservedSeconds, ids] of byValue) {
      await this.prisma.scheduledJob.updateMany({
        where: { id: { in: ids }, status: 'pending' },
        data: { reservedSeconds },
      });
    }
  }

  /** Choques ya existentes entre cadenas pendientes que comparten dispositivo (p. ej. creadas antes de la admisión). */
  async findConflicts(): Promise<SeriesConflictPair[]> {
    const all = await this.pendingSeries([]);
    const pairs: SeriesConflictPair[] = [];
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      const devices = new Set(a.devices);
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j];
        if (!b.devices.some((d) => devices.has(d))) continue;
        const hit = firstOverlap(a, b);
        if (hit) {
          pairs.push({
            a: { jobId: a.jobId, taskName: a.taskName },
            b: { jobId: b.jobId, taskName: b.taskName },
            at: hit.at.toISOString(),
          });
        }
      }
    }
    return pairs;
  }

  private assertAgainst(candidate: SeriesWindow, others: ReservedSeries[]): void {
    const conflicts: SeriesConflict[] = [];
    for (const o of others) {
      const hit = firstOverlap(candidate, o);
      if (hit) conflicts.push({ jobId: o.jobId, taskName: o.taskName, label: o.label, at: hit.at.toISOString() });
    }
    if (conflicts.length === 0) return;
    const { seriesStartAt, ...shape } = candidate;
    const suggested = suggestStart(shape, others, seriesStartAt);
    throw new ConflictException({
      message: SERIES_CONFLICT_MESSAGE,
      conflicts,
      suggestedStartAt: suggested ? suggested.toISOString() : null,
    });
  }

  /** Duraciones reales (s) de las últimas ejecuciones programadas completadas de la tarea. */
  private async recentDurations(taskId: number): Promise<number[]> {
    const rows = await this.prisma.scheduledJob.findMany({
      where: { taskId, status: 'completed', startedAt: { not: null }, finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' },
      take: RECENT_DURATIONS,
      select: { startedAt: true, finishedAt: true },
    });
    return rows.map((r) => Math.max(0, (r.finishedAt!.getTime() - r.startedAt!.getTime()) / 1000));
  }

  /** Cadenas pendientes con los dispositivos de su tarea (las tareas sin preferencia no ocupan nada). */
  private async pendingSeries(excludeJobIds: number[]): Promise<Array<ReservedSeries & { devices: string[] }>> {
    const jobs = await this.prisma.scheduledJob.findMany({
      where: { status: 'pending', ...(excludeJobIds.length ? { id: { notIn: excludeJobIds } } : {}) },
      select: pendingChainSelect,
      orderBy: { startAt: 'asc' },
    });
    if (jobs.length === 0) return [];
    const preferences = await this.prisma.taskPreference.findMany({
      where: { taskId: { in: [...new Set(jobs.map((j) => j.taskId))] } },
      orderBy: { createdAt: 'desc' },
      select: { taskId: true, sensorDeviceId: true, channelSelectorDeviceId: true },
    });
    const prefByTask = new Map<number, PrefDevices>();
    for (const p of preferences) if (!prefByTask.has(p.taskId)) prefByTask.set(p.taskId, p);
    const out: Array<ReservedSeries & { devices: string[] }> = [];
    for (const j of jobs) {
      const pref = prefByTask.get(j.taskId);
      if (!pref) continue;
      out.push({
        jobId: j.id,
        taskId: j.taskId,
        taskName: j.task.name,
        label: j.label,
        ...windowOf(j),
        devices: deviceIdsOf(pref),
      });
    }
    return out;
  }
}
