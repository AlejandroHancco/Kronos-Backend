import { BadRequestException, ConflictException } from '@nestjs/common';
import { SeriesReservationsService } from '@app/measurement';
import { ScheduledJobsService } from './scheduled-jobs.service';

const MIN = 60_000;
const t0 = new Date('2026-11-28T10:00:00.000Z');
const at = (min: number) => new Date(t0.getTime() + min * MIN);

/**
 * Tarea 1 (analizador A) ya tiene una serie pendiente cada 30 min desde t0 (10 min reservados).
 * Tarea 2 usa el equipo A; tarea 3 usa el equipo B.
 */
function setup() {
  const prefs = [
    { taskId: 1, sensorDeviceId: 'A', channelSelectorDeviceId: null },
    { taskId: 2, sensorDeviceId: 'A', channelSelectorDeviceId: null },
    { taskId: 3, sensorDeviceId: 'B', channelSelectorDeviceId: null },
  ];
  const pending = [{
    id: 10, taskId: 1, label: 'Curado', seriesStartAt: t0, intervalMinutes: 30, executionIndex: 1, repeatCount: 10,
    reservedSeconds: 600, channelNumbers: [1], task: { name: 'Losa', projectId: 'P1' },
  }];
  const prisma = {
    scheduledJob: {
      findMany: jest.fn(async (args: any) => (args.where.status === 'pending' ? pending : [])),
      create: jest.fn(async (args: any) => ({ id: 99, ...args.data })),
    },
    task: { findUnique: jest.fn(async () => ({ projectId: 'P1' })) },
    taskPreference: {
      findFirst: jest.fn(async (args: any) => prefs.find((p) => p.taskId === args.where.taskId) ?? null),
      findMany: jest.fn(async (args: any) => prefs.filter((p) => args.where.taskId.in.includes(p.taskId))),
    },
  };
  const teamScope = { assertTaskInTeam: jest.fn(), projectWhereForUser: jest.fn(async () => ({})) };
  const experimentConfig = { assertChannels: jest.fn(), resolve: jest.fn() };
  const reservations = new SeriesReservationsService(prisma as any, experimentConfig as any);
  jest.spyOn(reservations, 'reservedSecondsForTask').mockResolvedValue(600);
  const service = new ScheduledJobsService(prisma as any, teamScope as any, experimentConfig as any, reservations);
  return { service, prisma, reservations };
}

const dto = (over: Record<string, unknown> = {}) => ({
  taskId: 2, startAt: at(5).toISOString(), intervalMinutes: 30, repeatCount: 4, channelNumbers: [1], ...over,
}) as any;

describe('ScheduledJobsService.create (admisión de series)', () => {
  it('rechaza con 409 una serie que choca en el mismo equipo, con suggestedStartAt', async () => {
    const { service, prisma } = setup();
    const err = await service.create(dto(), 'u1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({
      message: 'La serie choca con otra medición programada en el mismo equipo',
      conflicts: [{ jobId: 10, taskName: 'Losa', label: 'Curado', at: at(5).toISOString() }],
      suggestedStartAt: at(10).toISOString(),
    });
    expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
    expect(prisma.scheduledJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'pending', task: { projectId: 'P1' } } }),
    );
  });

  it('acepta una serie en otro equipo a la misma hora', async () => {
    const { service, prisma } = setup();
    await service.create(dto({ taskId: 3 }), 'u1');
    expect(prisma.scheduledJob.create).toHaveBeenCalled();
  });

  it('rechaza con 400 una serie que se solapa consigo misma', async () => {
    const { service, prisma } = setup();
    await expect(service.create(dto({ taskId: 3, intervalMinutes: 5 }), 'u1')).rejects.toThrow(
      new BadRequestException('El intervalo es menor que la duración reservada de cada medición (10 min)'),
    );
    expect(prisma.scheduledJob.create).not.toHaveBeenCalled();
  });

  it('guarda seriesStartAt = startAt, reservedSeconds y toleranceMinutes (5 por defecto)', async () => {
    const { service, prisma, reservations } = setup();
    await service.create(dto({ taskId: 3, channelNumbers: [1, 2] }), 'u1');
    expect(reservations.reservedSecondsForTask).toHaveBeenCalledWith(3, 2);
    expect(prisma.scheduledJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        startAt: at(5).toISOString(),
        seriesStartAt: at(5).toISOString(),
        reservedSeconds: 600,
        toleranceMinutes: 5,
        taskId: 3,
        status: 'pending',
      }),
    });
    await service.create(dto({ taskId: 3, toleranceMinutes: 12 }), 'u1');
    expect(prisma.scheduledJob.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ toleranceMinutes: 12 }) });
  });
});

describe('ScheduledJobsService.findConflicts', () => {
  it('lista solo los choques preexistentes con ambas series en el equipo del usuario', async () => {
    const { service, prisma, reservations } = setup();
    jest.spyOn(reservations, 'findConflicts').mockResolvedValue([
      { a: { jobId: 10, taskName: 'Losa' }, b: { jobId: 20, taskName: 'Viga' }, at: at(0).toISOString() },
      { a: { jobId: 30, taskName: 'X' }, b: { jobId: 40, taskName: 'Y' }, at: at(0).toISOString() },
      { a: { jobId: 10, taskName: 'Losa' }, b: { jobId: 40, taskName: 'Y' }, at: at(0).toISOString() },
    ]);
    prisma.scheduledJob.findMany.mockResolvedValueOnce([{ id: 10 }, { id: 20 }] as any);
    expect(await service.findConflicts('u1')).toEqual([
      { a: { jobId: 10, taskName: 'Losa' }, b: { jobId: 20, taskName: 'Viga' }, at: at(0).toISOString() },
    ]);
  });
});
