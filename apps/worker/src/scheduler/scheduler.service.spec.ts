import { BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SCHEDULE_INTERVAL_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { SchedulerService } from './scheduler.service';
import { PRIORITY_SCHEDULED } from '@app/queue';
import { ExperimentConfigService } from '@app/experiments';

const sweepAcq = {
  kind: 'sweep' as const,
  variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia', rangeMinimum: 4, rangeMaximum: 5000000 },
  points: { minimum: 1, maximum: 801 },
  scales: ['LIN', 'LOG'] as const,
  secondsPerPoint: 0.01,
};
const singleAcq = { kind: 'single' as const, secondsPerReading: 2 }; // estimación: 2 s

const NOW = new Date('2026-10-21T12:00:00Z');
const MIN = 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

function job(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    taskId: 1,
    createdBy: 'user-1',
    label: 'cada hora',
    startAt: NOW,
    seriesStartAt: NOW,
    intervalMinutes: 60,
    repeatCount: 3,
    executionIndex: 1,
    toleranceMinutes: 5,
    reservedSeconds: 600,
    channelNumbers: [1],
    status: 'pending',
    ...over,
  };
}

function resolvedWith(acquisition: unknown, ranges: unknown[], over: Record<string, unknown> = {}) {
  return {
    preference: { taskId: 1, sensorDeviceId: 'S', channelSelectorDeviceId: null, ranges },
    sensor: { description: { shortName: 'Equipo' } },
    selector: null,
    acquisition,
    ...over,
  };
}

interface SetupOpts {
  leader?: boolean;
  /** dispositivos usados por jobs 'running' */
  busy?: string[];
  /** dispositivos con status offline */
  offline?: string[];
  /** series pendientes de otras cadenas en los mismos dispositivos */
  others?: unknown[];
}

/**
 * resolveFor: taskId → ResolvedExperiment | null | Error (lanzado por resolve).
 * Se usa el assertRanges real y la estimación de @app/measurement.
 */
function setup(dueJobs: any[], resolveFor: (taskId: number) => unknown, opts: SetupOpts = {}) {
  const { leader = true, busy = [], offline = [], others = [] } = opts;
  let nextId = 100;
  const prisma = {
    scheduledJob: {
      findMany: jest.fn(async (args: any) => (args?.where?.status === 'running' ? (busy.length ? [{ taskId: 50 }] : []) : dueJobs)),
      findUnique: jest.fn(async (args: any) => dueJobs.find((j) => j.id === args.where.id) ?? null),
      update: jest.fn(async (args: any) => ({ id: args.where.id })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async (args: any) => ({ id: nextId++, ...args.data })),
      createMany: jest.fn(async (args: any) => ({ count: args.data.length })),
    },
    taskPreference: {
      findMany: jest.fn(async () => busy.map((id) => ({ sensorDeviceId: id, channelSelectorDeviceId: null }))),
      findFirst: jest.fn(async () => null),
    },
    device: {
      findMany: jest.fn(async (args: any) =>
        (args.where.id.in as string[]).map((id) => ({ id, status: offline.includes(id) ? 'offline' : 'online' })),
      ),
    },
  };
  const experimentConfig = new ExperimentConfigService(null as any, null as any);
  const resolve = jest.spyOn(experimentConfig, 'resolve').mockImplementation(async (taskId: number) => {
    const r = resolveFor(taskId);
    if (r instanceof Error) throw r;
    return r as any;
  });
  const queue = { add: jest.fn(async () => ({ id: 'q1' })), getJobs: jest.fn(async () => []) };
  const realtime = { jobStatus: jest.fn() };
  const lockService = {
    runAsLeader: jest.fn(async (_name: string, _ttl: number, fn: () => Promise<void>) => {
      if (!leader) return false;
      await fn();
      return true;
    }),
  };
  const reservations = {
    projectOfTask: jest.fn(async () => 'proj-1'),
    seriesForDevices: jest.fn(async () => others),
  };
  const service = new SchedulerService(
    prisma as any, experimentConfig, realtime as any, lockService as any, queue as any, reservations as any,
  );
  return { service, prisma, queue, resolve, realtime, lockService, reservations };
}

/** Datos del job marcado missed con updateMany (o undefined). */
function missedUpdate(prisma: ReturnType<typeof setup>['prisma'], id = 7) {
  return prisma.scheduledJob.updateMany.mock.calls
    .map((c: any[]) => c[0])
    .find((a: any) => a.where.id === id && a.data.status === 'missed');
}

describe('SchedulerService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('tick', () => {
    it('corre cada 10 s con @Interval', () => {
      expect(Reflect.getMetadata(SCHEDULE_INTERVAL_OPTIONS, SchedulerService.prototype.processPendingJobs)).toEqual({ timeout: 10_000 });
    });

    it('corre solo como líder "scheduler" con TTL 8 000 ms (menor que el tick)', async () => {
      const { service, prisma, lockService } = setup([job()], () => resolvedWith(singleAcq, []), { leader: false });
      await service.processPendingJobs();
      expect(lockService.runAsLeader).toHaveBeenCalledWith('scheduler', 8_000, expect.any(Function));
      expect(prisma.scheduledJob.findMany).not.toHaveBeenCalled();
    });

    it('no solapa ticks: un tick en curso hace que el siguiente no haga nada', async () => {
      const { service, lockService } = setup([], () => null);
      let release!: () => void;
      lockService.runAsLeader.mockImplementationOnce(() => new Promise((r) => (release = () => r(true))));
      const first = service.processPendingJobs();
      await service.processPendingJobs();
      expect(lockService.runAsLeader).toHaveBeenCalledTimes(1);
      release();
      await first;
    });

    it('busca los pendientes que empiezan en ≤ 30 s', async () => {
      const { service, prisma } = setup([], () => null);
      await service.processPendingJobs();
      expect(prisma.scheduledJob.findMany).toHaveBeenCalledWith({
        where: { status: 'pending', startAt: { lte: at(30_000) } },
        orderBy: { startAt: 'asc' },
      });
    });
  });

  describe('encolado puntual', () => {
    it('a ≤ 30 s del inicio: job Bull diferido (delay = startAt − now, jobId determinista), running, plannedAt y tolerancia en el payload', async () => {
      const start = at(20_000);
      const { service, prisma, queue, realtime } = setup(
        [job({ startAt: start, seriesStartAt: start, toleranceMinutes: 3 })],
        () => resolvedWith(singleAcq, []),
      );
      await service.processPendingJobs();

      expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith({ where: { id: 7, status: 'pending' }, data: { status: 'running' } });
      expect(queue.add).toHaveBeenCalledWith(
        'execute',
        expect.objectContaining({
          taskId: 1, ranges: [], selectedChannels: [1], scheduledJobId: 7, executionIndex: 1, estimatedSeconds: 2,
          jobId: 'scheduled-7', plannedAt: start.toISOString(), toleranceMinutes: 3,
        }),
        expect.objectContaining({ jobId: 'scheduled-7', delay: 20_000, priority: PRIORITY_SCHEDULED, attempts: 3 }),
      );
      expect(realtime.jobStatus).toHaveBeenCalledWith('user-1', { jobId: 'scheduled-7', taskId: 1, status: 'queued' });
    });

    it('ya vencido dentro de la ventana: delay 0; la siguiente repetición va a la rejilla, no a now + intervalo', async () => {
      const series = at(-62 * MIN);
      const { service, prisma, queue } = setup(
        [job({ executionIndex: 2, repeatCount: 4, seriesStartAt: series, startAt: at(-2 * MIN), reservedSeconds: 120 })],
        () => resolvedWith(singleAcq, []),
      );
      await service.processPendingJobs();

      expect(queue.add).toHaveBeenCalledWith('execute', expect.anything(), expect.objectContaining({ delay: 0 }));
      expect(prisma.scheduledJob.create).toHaveBeenCalledWith({
        data: {
          taskId: 1, createdBy: 'user-1', label: 'cada hora',
          startAt: new Date(series.getTime() + 2 * 60 * MIN), // seriesStartAt + executionIndex × interval
          intervalMinutes: 60, repeatCount: 3, executionIndex: 3,
          seriesStartAt: series, toleranceMinutes: 5, reservedSeconds: 120, channelNumbers: [1],
          status: 'pending',
        },
      });
    });

    it('barrido: publica los rangos guardados y la estimación de @app/measurement', async () => {
      const ranges = [{ start: 1000, stop: 2000, points: 801, scale: 'LIN' }];
      const { service, queue } = setup([job()], () => resolvedWith(sweepAcq, ranges));
      await service.processPendingJobs();
      expect(queue.add).toHaveBeenCalledWith(
        'execute',
        expect.objectContaining({ ranges: [{ start: 1000, stop: 2000, points: 801, scale: 'LIN' }], estimatedSeconds: Math.ceil(1 + 8.01) }),
        expect.anything(),
      );
    });

    it('última repetición o serie única: no crea siguiente', async () => {
      const { service, prisma, queue } = setup(
        [job({ id: 7, repeatCount: 1 }), job({ id: 8, intervalMinutes: null, repeatCount: 1 })],
        () => resolvedWith(singleAcq, []),
      );
      await service.processPendingJobs();
      expect(queue.add).toHaveBeenCalledTimes(1); // 8 comparte dispositivo con 7, que ya lo ocupa
      expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
    });

    it('siguiente repetición ya existente (P2002 tras un reinicio): se ignora, sin error', async () => {
      const { service, prisma, queue } = setup([job()], () => resolvedWith(singleAcq, []));
      prisma.scheduledJob.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
      );
      await service.processPendingJobs();
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it('si otro proceso ya reclamó el job no publica ni crea la siguiente', async () => {
      const { service, prisma, queue } = setup([job()], () => resolvedWith(singleAcq, []));
      prisma.scheduledJob.updateMany.mockResolvedValueOnce({ count: 0 });
      await service.processPendingJobs();
      expect(queue.add).not.toHaveBeenCalled();
      expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
    });

    it('si publicar en la cola falla, el job vuelve a pending para el siguiente tick', async () => {
      const { service, prisma, queue } = setup([job()], () => resolvedWith(singleAcq, []));
      queue.add.mockRejectedValueOnce(new Error('redis caído'));
      await service.processPendingJobs();
      expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith({ where: { id: 7, status: 'running' }, data: { status: 'pending' } });
      expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
    });

    it('a menos de 30 s pero con el dispositivo ocupado: espera (sin missed aunque no haya hueco todavía)', async () => {
      const { service, prisma, queue } = setup([job({ startAt: at(20_000), seriesStartAt: at(20_000) })], () => resolvedWith(singleAcq, []), {
        busy: ['S'],
      });
      await service.processPendingJobs();
      expect(queue.add).not.toHaveBeenCalled();
      expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('no despachable: esperar o missed', () => {
    it('ocupado dentro de la ventana y con hueco: sigue pending', async () => {
      const { service, prisma, queue, reservations } = setup([job({ startAt: at(-2 * MIN), seriesStartAt: at(-2 * MIN) })], () => resolvedWith(singleAcq, []), {
        busy: ['S'],
        others: [{ seriesStartAt: at(30 * MIN), intervalMinutes: null, firstIndex: 1, lastIndex: 1, reservedSeconds: 60 }],
      });
      await service.processPendingJobs();
      expect(reservations.seriesForDevices).toHaveBeenCalledWith(['S'], [7], 'proj-1');
      expect(queue.add).not.toHaveBeenCalled();
      expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
      expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
    });

    it('offline dentro de la ventana: sigue pending', async () => {
      const { service, prisma, queue } = setup([job()], () => resolvedWith(singleAcq, []), { offline: ['S'] });
      await service.processPendingJobs();
      expect(queue.add).not.toHaveBeenCalled();
      expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
    });

    // ventana = startAt + 5 min + 30 s de gracia; startAt = now − 5 min 35 s ⇒ cerró hace 5 s
    const expired = { startAt: at(-(5 * MIN + 35_000)), seriesStartAt: at(-(5 * MIN + 35_000)) };

    it('ventana cerrada con el dispositivo ocupado: missed device_busy y la serie sigue en la rejilla', async () => {
      const { service, prisma, queue } = setup([job(expired)], () => resolvedWith(singleAcq, []), { busy: ['S'] });
      await service.processPendingJobs();
      expect(missedUpdate(prisma)).toEqual({ where: { id: 7, status: { in: ['pending', 'running'] } }, data: { status: 'missed', missReason: 'device_busy' } });
      expect(queue.add).not.toHaveBeenCalled();
      expect(prisma.scheduledJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ executionIndex: 2, repeatCount: 2, status: 'pending', startAt: new Date(expired.seriesStartAt.getTime() + 60 * MIN) }),
      });
    });

    it('ventana cerrada con el dispositivo offline: missed device_offline (prioridad sobre ocupado)', async () => {
      const { service, prisma } = setup([job(expired)], () => resolvedWith(singleAcq, []), { busy: ['S'], offline: ['S'] });
      await service.processPendingJobs();
      expect(missedUpdate(prisma)?.data).toEqual({ status: 'missed', missReason: 'device_offline' });
    });

    it('ventana cerrada con el dispositivo libre (tick tardío): missed tolerance_exceeded, no se mide tarde', async () => {
      const { service, prisma, queue } = setup([job(expired)], () => resolvedWith(singleAcq, []));
      await service.processPendingJobs();
      expect(missedUpdate(prisma)?.data).toEqual({ status: 'missed', missReason: 'tolerance_exceeded' });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('la próxima reserva no deja terminar (now + estimación > inicio): missed no_slot aunque la ventana siga abierta', async () => {
      const { service, prisma } = setup([job({ startAt: at(-MIN), seriesStartAt: at(-MIN) })], () => resolvedWith(singleAcq, []), {
        busy: ['S'],
        others: [{ seriesStartAt: at(1_000), intervalMinutes: null, firstIndex: 1, lastIndex: 1, reservedSeconds: 60 }],
      });
      await service.processPendingJobs();
      expect(missedUpdate(prisma)?.data).toEqual({ status: 'missed', missReason: 'no_slot' });
    });

    it('reserva justo al límite (now + estimación = inicio): aún espera', async () => {
      const { service, prisma } = setup([job({ startAt: at(-MIN), seriesStartAt: at(-MIN) })], () => resolvedWith(singleAcq, []), {
        busy: ['S'],
        others: [{ seriesStartAt: at(2_000), intervalMinutes: null, firstIndex: 1, lastIndex: 1, reservedSeconds: 60 }],
      });
      await service.processPendingJobs();
      expect(missedUpdate(prisma)).toBeUndefined();
    });

    it('ambos límites vencidos: decide el que cerró primero (hueco antes que ventana ⇒ no_slot)', async () => {
      // ventana cerró hace 5 s; el hueco cerró hace 8 s (reserva a now − 6 s, estimación 2 s)
      const { service, prisma } = setup([job(expired)], () => resolvedWith(singleAcq, []), {
        busy: ['S'],
        others: [{ seriesStartAt: at(-6_000), intervalMinutes: null, firstIndex: 1, lastIndex: 1, reservedSeconds: 60 }],
      });
      await service.processPendingJobs();
      expect(missedUpdate(prisma)?.data).toEqual({ status: 'missed', missReason: 'no_slot' });
    });

    it('ambos límites vencidos con la ventana primero: device_busy', async () => {
      // hueco cerró hace 2 s (reserva a now, estimación 2 s), después de la ventana (hace 5 s)
      const { service, prisma } = setup([job(expired)], () => resolvedWith(singleAcq, []), {
        busy: ['S'],
        others: [{ seriesStartAt: at(0), intervalMinutes: null, firstIndex: 1, lastIndex: 1, reservedSeconds: 60 }],
      });
      await service.processPendingJobs();
      expect(missedUpdate(prisma)?.data).toEqual({ status: 'missed', missReason: 'device_busy' });
    });
  });

  describe('recuperación tras caída (system_down)', () => {
    it('marca missed el job y cada punto de rejilla vencido, y deja un único pending en el primero con ventana abierta', async () => {
      const series = at(-(3 * 60 + 10) * MIN); // puntos: −3h10, −2h10, −1h10, −10min, +50min
      const { service, prisma, queue, resolve } = setup([job({ seriesStartAt: series, startAt: series, repeatCount: 10 })], () => resolvedWith(singleAcq, []));
      await service.processPendingJobs();

      expect(missedUpdate(prisma)).toEqual({ where: { id: 7, status: { in: ['pending', 'running'] } }, data: { status: 'missed', missReason: 'system_down' } });
      expect(prisma.scheduledJob.createMany).toHaveBeenCalledWith({
        data: [2, 3, 4].map((idx) => ({
          taskId: 1, createdBy: 'user-1', label: 'cada hora',
          startAt: new Date(series.getTime() + (idx - 1) * 60 * MIN),
          intervalMinutes: 60, repeatCount: 10 - (idx - 1), executionIndex: idx,
          seriesStartAt: series, toleranceMinutes: 5, reservedSeconds: 600, channelNumbers: [1],
          status: 'missed', missReason: 'system_down',
        })),
        skipDuplicates: true,
      });
      expect(prisma.scheduledJob.create).toHaveBeenCalledTimes(1);
      expect(prisma.scheduledJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ executionIndex: 5, repeatCount: 6, status: 'pending', startAt: new Date(series.getTime() + 4 * 60 * MIN) }),
      });
      expect(queue.add).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled(); // no se despacha
    });

    it('si el primer punto abierto ya venció dentro de su ventana, se despacha en el mismo tick', async () => {
      const series = at(-(3 * 60 + 2) * MIN); // punto 4 a now − 2 min (ventana abierta)
      const { service, prisma, queue } = setup([job({ seriesStartAt: series, startAt: series, repeatCount: 10 })], () => resolvedWith(singleAcq, []));
      await service.processPendingJobs();

      expect(prisma.scheduledJob.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: [expect.objectContaining({ executionIndex: 2 }), expect.objectContaining({ executionIndex: 3 })] }));
      expect(queue.add).toHaveBeenCalledWith(
        'execute',
        expect.objectContaining({ scheduledJobId: 100, executionIndex: 4, plannedAt: new Date(series.getTime() + 3 * 60 * MIN).toISOString() }),
        expect.objectContaining({ jobId: 'scheduled-100', delay: 0 }),
      );
    });

    it('cadena agotada: solo filas missed, ningún pending (bucle limitado por repeatCount)', async () => {
      const series = at(-(5 * 60) * MIN);
      const { service, prisma } = setup([job({ seriesStartAt: series, startAt: series, repeatCount: 3 })], () => resolvedWith(singleAcq, []));
      await service.processPendingJobs();
      expect(prisma.scheduledJob.createMany).toHaveBeenCalledWith(expect.objectContaining({
        data: [expect.objectContaining({ executionIndex: 2, repeatCount: 2 }), expect.objectContaining({ executionIndex: 3, repeatCount: 1 })],
      }));
      expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
    });

    it('serie única vencida hace rato: solo missed system_down', async () => {
      const { service, prisma } = setup([job({ intervalMinutes: null, repeatCount: 1, startAt: at(-60 * MIN), seriesStartAt: at(-60 * MIN) })], () => null);
      await service.processPendingJobs();
      expect(missedUpdate(prisma)?.data).toEqual({ status: 'missed', missReason: 'system_down' });
      expect(prisma.scheduledJob.createMany).not.toHaveBeenCalled();
      expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
    });

    it('si otro proceso ya resolvió el job, no crea filas', async () => {
      const series = at(-(3 * 60 + 10) * MIN);
      const { service, prisma } = setup([job({ seriesStartAt: series, startAt: series, repeatCount: 10 })], () => null);
      prisma.scheduledJob.updateMany.mockResolvedValueOnce({ count: 0 });
      await service.processPendingJobs();
      expect(prisma.scheduledJob.createMany).not.toHaveBeenCalled();
      expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
    });
  });

  describe('markMissed', () => {
    it('marca missed (pending o running) con el motivo y crea la siguiente repetición en la rejilla', async () => {
      const series = at(-30 * MIN);
      const { service, prisma } = setup([job({ id: 7, status: 'running', seriesStartAt: series, startAt: series })], () => null);
      await service.markMissed(7, 'tolerance_exceeded');
      expect(missedUpdate(prisma)).toEqual({ where: { id: 7, status: { in: ['pending', 'running'] } }, data: { status: 'missed', missReason: 'tolerance_exceeded' } });
      expect(prisma.scheduledJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ executionIndex: 2, repeatCount: 2, startAt: new Date(series.getTime() + 60 * MIN) }),
      });
    });

    it('job inexistente o ya terminado: no hace nada más', async () => {
      const { service, prisma } = setup([job()], () => null);
      prisma.scheduledJob.updateMany.mockResolvedValueOnce({ count: 0 });
      await service.markMissed(7, 'device_busy');
      await service.markMissed(404, 'device_busy');
      expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
    });
  });

  describe('errores de configuración (failed, como antes)', () => {
    it('barrido sin rangos: marca failed sin reclamar el job', async () => {
      const { service, prisma, queue } = setup([job()], () => resolvedWith(sweepAcq, []));
      await service.processPendingJobs();
      expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
      expect(prisma.scheduledJob.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { status: 'failed' } });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('sin canales: failed', async () => {
      const { service, prisma, queue } = setup([job({ channelNumbers: [] })], () => resolvedWith(singleAcq, []));
      await service.processPendingJobs();
      expect(prisma.scheduledJob.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { status: 'failed' } });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('resolve lanza: el job queda failed (nunca running) y el bucle sigue con el siguiente', async () => {
      const ranges = [{ start: 1000, stop: 2000, points: 801, scale: 'LIN' }];
      const { service, prisma, queue } = setup(
        [job({ id: 7, taskId: 1 }), job({ id: 8, taskId: 2, intervalMinutes: null, repeatCount: 1 })],
        (taskId) => (taskId === 1 ? new BadRequestException('tipo de dispositivo inconsistente') : resolvedWith(sweepAcq, ranges)),
      );
      await service.processPendingJobs();

      expect(prisma.scheduledJob.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { status: 'failed' } });
      expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7, status: 'pending' } }));
      expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith({ where: { id: 8, status: 'pending' }, data: { status: 'running' } });
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith('execute', expect.objectContaining({ scheduledJobId: 8 }), expect.anything());
    });

    it('resolve devuelve null (sin equipo de medición): failed sin reclamar', async () => {
      const { service, prisma, queue } = setup([job()], () => null);
      await service.processPendingJobs();
      expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
      expect(prisma.scheduledJob.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { status: 'failed' } });
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
