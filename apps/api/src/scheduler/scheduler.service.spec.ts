import { BadRequestException, Logger } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { PRIORITY_SCHEDULED } from '@app/queue';
import { MeasurementSchedulingService } from './scheduling.service';
import { ExperimentConfigService } from '@app/experiments';

const sweepAcq = {
  kind: 'sweep' as const,
  variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia', rangeMinimum: 4, rangeMaximum: 5000000 },
  points: { minimum: 1, maximum: 801 },
  scales: ['LIN', 'LOG'] as const,
  secondsPerPoint: 0.01,
};
const singleAcq = { kind: 'single' as const, secondsPerReading: 2 };

const NOW = new Date('2026-10-21T12:00:00Z');

function job(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    taskId: 1,
    createdBy: 'user-1',
    label: 'cada hora',
    startAt: NOW,
    intervalMinutes: 60,
    repeatCount: 3,
    executionIndex: 1,
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

/**
 * resolveFor: taskId → ResolvedExperiment | null | Error (lanzado por resolve).
 * Se usa el MeasurementSchedulingService real (helper compartido) y el assertRanges real.
 */
function setup(dueJobs: any[], resolveFor: (taskId: number) => unknown) {
  const prisma = {
    scheduledJob: {
      findMany: jest.fn(async (args: any) => (args?.where?.status === 'running' ? [] : dueJobs)),
      update: jest.fn(async (args: any) => ({ id: args.where.id })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async (args: any) => ({ id: 99, ...args.data })),
    },
    taskPreference: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  };
  const experimentConfig = new ExperimentConfigService(null as any, null as any);
  const resolve = jest.spyOn(experimentConfig, 'resolve').mockImplementation(async (taskId: number) => {
    const r = resolveFor(taskId);
    if (r instanceof Error) throw r;
    return r as any;
  });
  const queue = { add: jest.fn(async () => ({ id: 'q1' })), getJobs: jest.fn(async () => []) };
  const kronosGateway = { jobStatus: jest.fn() };
  const scheduling = new MeasurementSchedulingService(
    prisma as any, kronosGateway as any, experimentConfig, queue as any,
  );
  const service = new SchedulerService(
    prisma as any, scheduling, kronosGateway as any, queue as any, experimentConfig,
  );
  return { service, prisma, queue, resolve, kronosGateway };
}

describe('SchedulerService.processPendingJobs', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('tarea de lectura puntual (sin rangos): despacha el job y programa la siguiente repetición', async () => {
    const { service, prisma, queue } = setup([job()], () => resolvedWith(singleAcq, []));
    await service.processPendingJobs();

    expect(prisma.scheduledJob.update).not.toHaveBeenCalled(); // no se marca failed
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith({ where: { id: 7, status: 'pending' }, data: { status: 'running' } });
    expect(queue.add).toHaveBeenCalledWith(
      'execute',
      expect.objectContaining({ taskId: 1, ranges: [], selectedChannels: [1], scheduledJobId: 7, estimatedSeconds: 2 }),
      expect.objectContaining({ priority: PRIORITY_SCHEDULED }),
    );
    expect(prisma.scheduledJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: 1, repeatCount: 2, executionIndex: 2, status: 'pending',
        startAt: new Date(NOW.getTime() + 60 * 60_000),
      }),
    });
  });

  it('barrido: despacha con los rangos guardados y la estimación del helper compartido', async () => {
    const ranges = [{ start: 1000, stop: 2000, points: 801, scale: 'LIN' }];
    const { service, queue } = setup([job()], () => resolvedWith(sweepAcq, ranges));
    await service.processPendingJobs();
    expect(queue.add).toHaveBeenCalledWith(
      'execute',
      expect.objectContaining({ ranges: [{ start: 1000, stop: 2000, points: 801, scale: 'LIN' }], estimatedSeconds: Math.ceil(1 + 8.01) }),
      expect.anything(),
    );
  });

  it('barrido sin rangos: marca failed sin reclamar el job', async () => {
    const { service, prisma, queue } = setup([job()], () => resolvedWith(sweepAcq, []));
    await service.processPendingJobs();
    expect(prisma.scheduledJob.updateMany).not.toHaveBeenCalled();
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
