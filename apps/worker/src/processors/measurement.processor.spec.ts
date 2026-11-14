import type { Job } from 'bull';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { DeviceStateService, RedisLockService } from '@app/redis';
import type { MeasurementJobData } from '@app/queue';
import { MeasurementProcessor } from './measurement.processor';

const makeJob = (over: Partial<MeasurementJobData> = {}) =>
  ({
    id: 77,
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: { taskId: 5, userId: 'u1', ranges: [], selectedChannels: [1], jobId: 'manual-1', estimatedSeconds: 10, ...over },
  }) as unknown as Job<MeasurementJobData>;

function setup(preference: unknown, lockService: any) {
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
    scheduledJob: { update: jest.fn(async () => ({})) },
  };
  const processor = new MeasurementProcessor(executor as any, realtime as any, prisma as any, lockService);
  return { processor, executor, realtime, prisma, order };
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

  it('job de un ScheduledJob: lo marca completed', async () => {
    const lockService = { withDeviceLocks: jest.fn(async (_ids: string[], fn: () => Promise<unknown>) => fn()) };
    const { processor, prisma } = setup({ sensorDeviceId: 'S', channelSelectorDeviceId: null }, lockService);
    await processor.handleExecute(makeJob({ scheduledJobId: 9, executionIndex: 2 }));
    expect(prisma.scheduledJob.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { status: 'completed' } });
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
