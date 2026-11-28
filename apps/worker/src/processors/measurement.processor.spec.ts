import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { DeviceBusyTimeoutError, DeviceStateService, RedisLockService } from '@app/redis';
import type { MeasurementJobData } from '@app/queue';
import { MeasurementProcessor } from './measurement.processor';

const makeJob = (over: Partial<MeasurementJobData> = {}) =>
  ({
    id: 77,
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: { taskId: 5, userId: 'u1', ranges: [], selectedChannels: [1], jobId: 'manual-1', estimatedSeconds: 10, ...over },
  }) as unknown as Job<MeasurementJobData>;

interface ScheduledOpts {
  /** fila ScheduledJob que devuelve findUnique */
  row?: any;
  /** dispositivos offline */
  offline?: string[];
  /** series pendientes / ocurrencias running en los mismos dispositivos */
  series?: any[];
  running?: any[];
}

function setup(preference: unknown, lockService: any, opts: ScheduledOpts = {}) {
  const order: string[] = [];
  const executor = {
    measureTask: jest.fn(async () => {
      order.push('measure');
      return { ok: true };
    }),
  };
  const realtime = { jobStatus: jest.fn((_u: string, s: { status: string }) => order.push(`status:${s.status}`)) };
  const prisma = {
    taskPreference: { findFirst: jest.fn(async () => preference) },
    scheduledJob: {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => opts.row ?? null),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    device: {
      findMany: jest.fn(async (args: any) =>
        (args.where.id.in as string[]).map((id) => ({ id, status: opts.offline?.includes(id) ? 'offline' : 'online' })),
      ),
    },
  };
  const scheduler = { markMissed: jest.fn(async () => undefined) };
  const reservations = {
    projectOfTask: jest.fn(async () => 'proj-1'),
    seriesForDevices: jest.fn(async () => opts.series ?? []),
    runningForDevices: jest.fn(async () => opts.running ?? []),
  };
  const processor = new MeasurementProcessor(
    executor as any,
    realtime as any,
    prisma as any,
    lockService,
    scheduler as any,
    reservations as any,
  );
  return { processor, executor, realtime, prisma, order, scheduler, reservations };
}

describe('MeasurementProcessor.handleExecute', () => {
  it('mide bajo los locks del sensor y del selector y emite processing → completed con jobId = String(job.id)', async () => {
    const order: string[] = [];
    const lockService = {
      withDeviceLocks: jest.fn(async (_ids: string[], fn: () => Promise<unknown>) => {
        order.push('lock');
        return fn();
      }),
    };
    const ctx = setup({ sensorDeviceId: 'S', channelSelectorDeviceId: 'M' }, lockService);
    ctx.realtime.jobStatus.mockImplementation((_u, s) => order.push(`status:${s.status}`));
    ctx.executor.measureTask.mockImplementation(async () => {
      order.push('measure');
      return { ok: true };
    });

    const result = await ctx.processor.handleExecute(makeJob());

    expect(result).toEqual({ ok: true });
    expect(lockService.withDeviceLocks).toHaveBeenCalledWith(['S', 'M'], expect.any(Function));
    expect(ctx.prisma.taskPreference.findFirst).toHaveBeenCalledWith({
      where: { taskId: 5 },
      orderBy: { createdAt: 'desc' },
      select: { sensorDeviceId: true, channelSelectorDeviceId: true },
    });
    expect(ctx.executor.measureTask).toHaveBeenCalledWith(5, 'u1', expect.objectContaining({ jobId: 'manual-1' }));
    expect(order).toEqual(['status:processing', 'lock', 'measure', 'status:completed']);
    expect(ctx.realtime.jobStatus.mock.calls.map(([u, s]: any[]) => [u, s.status, s.jobId])).toEqual([
      ['u1', 'processing', '77'],
      ['u1', 'completed', '77'],
    ]);
  });

  it('sin selector bloquea solo el sensor', async () => {
    const lockService = { withDeviceLocks: jest.fn(async (_ids: string[], fn: () => Promise<unknown>) => fn()) };
    const { processor } = setup({ sensorDeviceId: 'S', channelSelectorDeviceId: null }, lockService);
    await processor.handleExecute(makeJob());
    expect(lockService.withDeviceLocks).toHaveBeenCalledWith(['S'], expect.any(Function));
  });

  it('sin preferencia mide sin locks (measureTask falla con su propio error)', async () => {
    const lockService = { withDeviceLocks: jest.fn() };
    const { processor, executor } = setup(null, lockService);
    await processor.handleExecute(makeJob());
    expect(lockService.withDeviceLocks).not.toHaveBeenCalled();
    expect(executor.measureTask).toHaveBeenCalled();
  });

  it('si la preferencia cambió mientras esperaba los locks (dispositivo no bloqueado): error reintentable, sin medir', async () => {
    const lockService = { withDeviceLocks: jest.fn(async (_ids: string[], fn: () => Promise<unknown>) => fn()) };
    const { processor, prisma, executor } = setup({ sensorDeviceId: 'S', channelSelectorDeviceId: null }, lockService);
    prisma.taskPreference.findFirst
      .mockResolvedValueOnce({ sensorDeviceId: 'S', channelSelectorDeviceId: null })
      .mockResolvedValueOnce({ sensorDeviceId: 'S', channelSelectorDeviceId: 'M2' });
    await expect(processor.handleExecute(makeJob())).rejects.toThrow(
      'La configuración de la tarea cambió mientras esperaba el equipo; se reintentará',
    );
    expect(prisma.taskPreference.findFirst).toHaveBeenCalledTimes(2);
    expect(executor.measureTask).not.toHaveBeenCalled();
  });

  it('si tras los locks la preferencia sigue dentro de los ids bloqueados (p. ej. se quitó el MUX), mide', async () => {
    const lockService = { withDeviceLocks: jest.fn(async (_ids: string[], fn: () => Promise<unknown>) => fn()) };
    const { processor, prisma, executor } = setup({ sensorDeviceId: 'S', channelSelectorDeviceId: 'M' }, lockService);
    prisma.taskPreference.findFirst
      .mockResolvedValueOnce({ sensorDeviceId: 'S', channelSelectorDeviceId: 'M' })
      .mockResolvedValueOnce({ sensorDeviceId: 'S', channelSelectorDeviceId: null });
    await processor.handleExecute(makeJob());
    expect(executor.measureTask).toHaveBeenCalledTimes(1);
  });

  it('manual: no toca ScheduledJob ni consulta ventana/reservas', async () => {
    const lockService = { withDeviceLocks: jest.fn(async (_ids: string[], fn: () => Promise<unknown>) => fn()) };
    const { processor, prisma, scheduler, reservations } = setup({ sensorDeviceId: 'S', channelSelectorDeviceId: null }, lockService);
    await processor.handleExecute(makeJob());
    expect(prisma.scheduledJob.findUnique).not.toHaveBeenCalled();
    expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
    expect(prisma.scheduledJob.update).not.toHaveBeenCalled();
    expect(scheduler.markMissed).not.toHaveBeenCalled();
    expect(reservations.seriesForDevices).not.toHaveBeenCalled();
  });

  it('mientras DeviceStateService.withExclusive tiene el dispositivo (configurándose), la medición ESPERA y empieza al liberarse', async () => {
    const redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    const locks = new RedisLockService(redis);
    const deviceState = new DeviceStateService(redis, locks, {} as any);
    // Mismo RedisLockService real; solo se acorta el sondeo para el test.
    const lockService = {
      withDeviceLocks: jest.fn((ids: string[], fn: () => Promise<unknown>) => locks.withDeviceLocks(ids, fn, { pollMs: 10 })),
    };
    const { processor, executor, order } = setup({ sensorDeviceId: 'S', channelSelectorDeviceId: 'M' }, lockService);

    let release!: () => void;
    const configuring = deviceState.withExclusive({ id: 'M', name: 'MUX' }, async () => {
      order.push('configure:start');
      await new Promise<void>((r) => (release = r));
      order.push('configure:end');
    });
    await new Promise((r) => setTimeout(r, 5));

    const measuring = processor.handleExecute(makeJob());
    let measuredWhileConfiguring: boolean;
    try {
      await new Promise((r) => setTimeout(r, 60));
      measuredWhileConfiguring = executor.measureTask.mock.calls.length > 0;
      expect(await redis.get('lock:device:M')).not.toBeNull();
    } finally {
      release();
      await configuring;
      await measuring;
    }
    expect(measuredWhileConfiguring).toBe(false);

    expect(executor.measureTask).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['configure:start', 'status:processing', 'configure:end', 'measure', 'status:completed']);
    expect(await redis.exists('lock:device:M', 'lock:device:S')).toBe(0);
    redis.disconnect();
  });
});

describe('MeasurementProcessor: concurrencia', () => {
  it("@Process({ name: 'execute', concurrency: 4 })", () => {
    const meta = Reflect.getMetadata('bull:module_queue_process', MeasurementProcessor.prototype.handleExecute);
    expect(meta).toEqual({ name: 'execute', concurrency: 4 });
  });
});

describe('MeasurementProcessor: jobs programados (ventana y hueco)', () => {
  const NOW = new Date('2026-11-27T12:00:00Z');
  const MIN = 60_000;
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const pref = { sensorDeviceId: 'S', channelSelectorDeviceId: null };
  const row = (over: Record<string, unknown> = {}) => ({
    id: 9,
    taskId: 5,
    status: 'running',
    startAt: NOW,
    seriesStartAt: NOW,
    toleranceMinutes: 5,
    ...over,
  });
  const scheduledJob = (over: Partial<MeasurementJobData> = {}, attemptsMade = 0) => {
    const j = makeJob({
      scheduledJobId: 9,
      executionIndex: 1,
      jobId: 'scheduled-9',
      plannedAt: NOW.toISOString(),
      toleranceMinutes: 5,
      estimatedSeconds: 60,
      ...over,
    }) as any;
    j.attemptsMade = attemptsMade;
    return j as Job<MeasurementJobData>;
  };
  const passLock = () => ({
    withDeviceLocks: jest.fn(async (_ids: string[], fn: () => Promise<unknown>, _o?: unknown) => fn()),
  });
  // ventana: NOW + 5 min + 30 s de gracia
  const WINDOW_END = NOW.getTime() + 5 * MIN + 30_000;

  beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  const condUpdates = (prisma: any) => prisma.scheduledJob.updateMany.mock.calls.map((c: any[]) => c[0]);

  it('la espera del lock es fin de ventana − now', async () => {
    jest.setSystemTime(at(2 * MIN));
    const lockService = passLock();
    const { processor } = setup(pref, lockService, { row: row() });
    await processor.handleExecute(scheduledJob());
    expect(lockService.withDeviceLocks).toHaveBeenCalledWith(['S'], expect.any(Function), {
      waitTimeoutMs: WINDOW_END - at(2 * MIN).getTime(),
    });
  });

  it('éxito: startedAt al tomar el lock, delaySeconds redondeado, finishedAt y completed (condicionales a running)', async () => {
    jest.setSystemTime(at(1000));
    const lockService = {
      withDeviceLocks: jest.fn(async (_ids: string[], fn: () => Promise<unknown>) => {
        jest.setSystemTime(at(90_400)); // esperó el lock
        return fn();
      }),
    };
    const ctx = setup(pref, lockService, { row: row() });
    ctx.executor.measureTask.mockImplementation(async () => {
      jest.setSystemTime(at(150_000));
      return { ok: true };
    });
    const result = await ctx.processor.handleExecute(scheduledJob());
    expect(result).toEqual({ ok: true });
    expect(condUpdates(ctx.prisma)).toEqual([
      { where: { id: 9, status: 'running' }, data: { startedAt: at(90_400), delaySeconds: 90 } },
      { where: { id: 9, status: 'running' }, data: { status: 'completed', finishedAt: at(150_000) } },
    ]);
    expect(ctx.prisma.scheduledJob.update).not.toHaveBeenCalled();
    expect(ctx.scheduler.markMissed).not.toHaveBeenCalled();
    expect(ctx.realtime.jobStatus.mock.calls.map(([, s]: any[]) => s.status)).toEqual(['processing', 'completed']);
  });

  it('delaySeconds nunca negativo (empezó antes de lo planificado)', async () => {
    jest.setSystemTime(at(-2000));
    const ctx = setup(pref, passLock(), { row: row() });
    await ctx.processor.handleExecute(scheduledJob());
    expect(condUpdates(ctx.prisma)[0].data).toEqual({ startedAt: at(-2000), delaySeconds: 0 });
  });

  it('llega con la ventana ya cerrada (p. ej. un reintento): missed tolerance_exceeded, sin lock ni medir, sin lanzar', async () => {
    jest.setSystemTime(new Date(WINDOW_END + 1));
    const lockService = passLock();
    const ctx = setup(pref, lockService, { row: row() });
    await expect(ctx.processor.handleExecute(scheduledJob({}, 1))).resolves.toBeNull();
    expect(ctx.scheduler.markMissed).toHaveBeenCalledWith(9, 'tolerance_exceeded');
    expect(lockService.withDeviceLocks).not.toHaveBeenCalled();
    expect(ctx.executor.measureTask).not.toHaveBeenCalled();
  });

  it('justo en el fin de ventana (espera 0) también es missed', async () => {
    jest.setSystemTime(new Date(WINDOW_END));
    const lockService = passLock();
    const ctx = setup(pref, lockService, { row: row() });
    await ctx.processor.handleExecute(scheduledJob());
    expect(ctx.scheduler.markMissed).toHaveBeenCalledWith(9, 'tolerance_exceeded');
    expect(ctx.executor.measureTask).not.toHaveBeenCalled();
  });

  it('un reintento dentro de la ventana mide normalmente', async () => {
    jest.setSystemTime(at(3 * MIN));
    const ctx = setup(pref, passLock(), { row: row() });
    await ctx.processor.handleExecute(scheduledJob({}, 2));
    expect(ctx.executor.measureTask).toHaveBeenCalledTimes(1);
  });

  it('timeout del lock (dispositivo ocupado): missed device_busy, sin lanzar', async () => {
    const lockService = {
      withDeviceLocks: jest.fn(async () => {
        throw new DeviceBusyTimeoutError(['S'], 1000);
      }),
    };
    const ctx = setup(pref, lockService, { row: row() });
    await expect(ctx.processor.handleExecute(scheduledJob())).resolves.toBeNull();
    expect(ctx.scheduler.markMissed).toHaveBeenCalledWith(9, 'device_busy');
    expect(ctx.executor.measureTask).not.toHaveBeenCalled();
  });

  it('timeout del lock con un dispositivo offline: missed device_offline', async () => {
    const lockService = {
      withDeviceLocks: jest.fn(async () => {
        throw new DeviceBusyTimeoutError(['S'], 1000);
      }),
    };
    const ctx = setup(pref, lockService, { row: row(), offline: ['S'] });
    await ctx.processor.handleExecute(scheduledJob());
    expect(ctx.scheduler.markMissed).toHaveBeenCalledWith(9, 'device_offline');
  });

  it('dentro del lock la ventana ya cerró: missed tolerance_exceeded sin medir', async () => {
    const lockService = {
      withDeviceLocks: jest.fn(async (_ids: string[], fn: () => Promise<unknown>) => {
        jest.setSystemTime(new Date(WINDOW_END + 1));
        return fn();
      }),
    };
    const ctx = setup(pref, lockService, { row: row() });
    await expect(ctx.processor.handleExecute(scheduledJob())).resolves.toBeNull();
    expect(ctx.scheduler.markMissed).toHaveBeenCalledWith(9, 'tolerance_exceeded');
    expect(ctx.executor.measureTask).not.toHaveBeenCalled();
    expect(condUpdates(ctx.prisma)).toEqual([]);
  });

  it('dentro del lock no cabe antes de la próxima reserva de sus dispositivos: missed no_slot sin medir', async () => {
    jest.setSystemTime(at(2 * MIN));
    // otra serie empieza en NOW + 2,5 min; estimación 60 s ⇒ terminaría en NOW + 3 min
    const other = { jobId: 50, taskId: 6, seriesStartAt: at(2.5 * MIN), intervalMinutes: null, firstIndex: 1, lastIndex: 1, reservedSeconds: 120 };
    const ctx = setup(pref, passLock(), { row: row(), series: [other] });
    await expect(ctx.processor.handleExecute(scheduledJob())).resolves.toBeNull();
    expect(ctx.reservations.seriesForDevices).toHaveBeenCalledWith(['S'], [9], 'proj-1');
    expect(ctx.reservations.runningForDevices).toHaveBeenCalledWith(['S'], [9], 'proj-1');
    expect(ctx.scheduler.markMissed).toHaveBeenCalledWith(9, 'no_slot');
    expect(ctx.executor.measureTask).not.toHaveBeenCalled();
  });

  it('una ocurrencia running de otra serie que empieza antes de terminar también limita (no_slot)', async () => {
    jest.setSystemTime(at(2 * MIN));
    const other = { jobId: 51, taskId: 6, seriesStartAt: at(2.5 * MIN), intervalMinutes: null, firstIndex: 1, lastIndex: 1, reservedSeconds: 120 };
    const ctx = setup(pref, passLock(), { row: row(), running: [other] });
    await ctx.processor.handleExecute(scheduledJob());
    expect(ctx.scheduler.markMissed).toHaveBeenCalledWith(9, 'no_slot');
  });

  it('cabe justo (now + estimación = próxima reserva): mide', async () => {
    jest.setSystemTime(at(2 * MIN));
    const other = { jobId: 50, taskId: 6, seriesStartAt: at(3 * MIN), intervalMinutes: null, firstIndex: 1, lastIndex: 1, reservedSeconds: 120 };
    const ctx = setup(pref, passLock(), { row: row(), series: [other] });
    await ctx.processor.handleExecute(scheduledJob());
    expect(ctx.executor.measureTask).toHaveBeenCalledTimes(1);
  });

  it('la propia cadena (su siguiente punto pending, otra fila) no limita el hueco', async () => {
    jest.setSystemTime(at(2 * MIN));
    const own = { jobId: 10, taskId: 5, seriesStartAt: NOW, intervalMinutes: 2.5, firstIndex: 2, lastIndex: 3, reservedSeconds: 70 };
    const ctx = setup(pref, passLock(), { row: row(), series: [own] });
    await ctx.processor.handleExecute(scheduledJob());
    expect(ctx.executor.measureTask).toHaveBeenCalledTimes(1);
  });

  it('la fila ya no está running (p. ej. el reaper la marcó missed): no mide', async () => {
    const lockService = passLock();
    const ctx = setup(pref, lockService, { row: row({ status: 'missed' }) });
    await expect(ctx.processor.handleExecute(scheduledJob())).resolves.toBeNull();
    expect(ctx.executor.measureTask).not.toHaveBeenCalled();
    expect(ctx.scheduler.markMissed).not.toHaveBeenCalled();
  });

  it('midió pero la fila dejó de estar running: no la pisa, avisa y devuelve el resultado', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const ctx = setup(pref, passLock(), { row: row() });
    ctx.prisma.scheduledJob.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await expect(ctx.processor.handleExecute(scheduledJob())).resolves.toEqual({ ok: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ya no estaba running'));
    warn.mockRestore();
  });

  it('sin plannedAt en el payload usa startAt/toleranceMinutes de la fila', async () => {
    jest.setSystemTime(at(7 * MIN));
    const ctx = setup(pref, passLock(), { row: row({ toleranceMinutes: 10 }) });
    await ctx.processor.handleExecute(scheduledJob({ plannedAt: undefined, toleranceMinutes: undefined }));
    expect(ctx.executor.measureTask).toHaveBeenCalledTimes(1);
  });

  it('error al medir: se propaga (Bull reintenta) sin marcar missed', async () => {
    const ctx = setup(pref, passLock(), { row: row() });
    ctx.executor.measureTask.mockRejectedValueOnce(new Error('timeout VNA'));
    await expect(ctx.processor.handleExecute(scheduledJob())).rejects.toThrow('timeout VNA');
    expect(ctx.scheduler.markMissed).not.toHaveBeenCalled();
  });
});

describe('MeasurementProcessor.onFailed', () => {
  it('fallo definitivo de un programado: failed solo si sigue running', async () => {
    const { processor, prisma } = setup(null, {});
    const job = makeJob({ scheduledJobId: 9 }) as any;
    job.attemptsMade = 3;
    await processor.onFailed(job, new Error('x'));
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith({ where: { id: 9, status: 'running' }, data: { status: 'failed' } });
    expect(prisma.scheduledJob.update).not.toHaveBeenCalled();
  });

  it('con reintentos pendientes no toca la fila', async () => {
    const { processor, prisma } = setup(null, {});
    const job = makeJob({ scheduledJobId: 9 }) as any;
    job.attemptsMade = 1;
    await processor.onFailed(job, new Error('x'));
    expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
  });
});
