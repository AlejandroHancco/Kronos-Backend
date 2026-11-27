import { BadRequestException, ConflictException } from '@nestjs/common';
import { SeriesReservationsService } from './series-reservations.service';

const MIN = 60_000;
const t0 = new Date('2026-11-28T10:00:00.000Z');
const at = (min: number) => new Date(t0.getTime() + min * MIN);

const hiokiAcq = {
  kind: 'sweep' as const,
  variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia', rangeMinimum: 4, rangeMaximum: 5000000 },
  points: { minimum: 1, maximum: 801 },
  scales: ['LIN', 'LOG'] as const,
  secondsPerPoint: 0.01,
};

interface JobRow {
  id: number;
  taskId: number;
  label: string | null;
  seriesStartAt: Date;
  intervalMinutes: number | null;
  executionIndex: number;
  repeatCount: number;
  reservedSeconds: number;
  channelNumbers: number[];
  task: { name: string };
}

const job = (over: Partial<JobRow>): JobRow => ({
  id: 1, taskId: 1, label: null, seriesStartAt: t0, intervalMinutes: 30, executionIndex: 1, repeatCount: 10,
  reservedSeconds: 600, channelNumbers: [1], task: { name: 'Tarea 1' }, ...over,
});

/** prisma simulado: filtra jobs pendientes por status/taskId/id notIn como lo haría la BD. */
function setup(opts: {
  pending?: JobRow[];
  prefs?: Array<{ taskId: number; sensorDeviceId: string; channelSelectorDeviceId: string | null }>;
  completed?: Array<{ startedAt: Date; finishedAt: Date }>;
  resolved?: any;
} = {}) {
  const pending = opts.pending ?? [];
  const prefs = opts.prefs ?? [];
  const prisma = {
    scheduledJob: {
      findMany: jest.fn(async (args: any) => {
        const w = args.where;
        if (w.status === 'completed') return opts.completed ?? [];
        return pending.filter(
          (j) =>
            (w.taskId === undefined || j.taskId === w.taskId) &&
            !(w.id?.notIn ?? []).includes(j.id),
        );
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    taskPreference: {
      findFirst: jest.fn(async (args: any) => prefs.find((p) => p.taskId === args.where.taskId) ?? null),
      findMany: jest.fn(async (args: any) => prefs.filter((p) => args.where.taskId.in.includes(p.taskId))),
    },
  };
  const experimentConfig = { resolve: jest.fn(async () => opts.resolved ?? null) };
  return { service: new SeriesReservationsService(prisma as any, experimentConfig as any), prisma, experimentConfig };
}

describe('SeriesReservationsService.devicesOfTask', () => {
  it('sensor + selector de la preferencia más reciente; [] sin preferencia', async () => {
    const { service, prisma } = setup({ prefs: [{ taskId: 1, sensorDeviceId: 'A', channelSelectorDeviceId: 'M' }] });
    expect(await service.devicesOfTask(1)).toEqual(['A', 'M']);
    expect(await service.devicesOfTask(2)).toEqual([]);
    expect(prisma.taskPreference.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { taskId: 1 }, orderBy: { createdAt: 'desc' } }),
    );
  });
});

describe('SeriesReservationsService.seriesForDevices', () => {
  it('una entrada por cadena pendiente que comparte dispositivo; ventana executionIndex..executionIndex+repeatCount−1', async () => {
    const { service, prisma } = setup({
      pending: [
        job({ id: 10, taskId: 1, executionIndex: 3, repeatCount: 4, label: 'L1', task: { name: 'T1' } }),
        job({ id: 20, taskId: 2, task: { name: 'T2' } }),
        job({ id: 30, taskId: 3, task: { name: 'T3' } }),
      ],
      prefs: [
        { taskId: 1, sensorDeviceId: 'A', channelSelectorDeviceId: null },
        { taskId: 2, sensorDeviceId: 'B', channelSelectorDeviceId: 'M' },
        { taskId: 3, sensorDeviceId: 'C', channelSelectorDeviceId: null },
      ],
    });
    const out = await service.seriesForDevices(['A', 'M']);
    expect(out).toEqual([
      { jobId: 10, taskId: 1, taskName: 'T1', label: 'L1', seriesStartAt: t0, intervalMinutes: 30, firstIndex: 3, lastIndex: 6, reservedSeconds: 600 },
      { jobId: 20, taskId: 2, taskName: 'T2', label: null, seriesStartAt: t0, intervalMinutes: 30, firstIndex: 1, lastIndex: 10, reservedSeconds: 600 },
    ]);
    expect(await service.seriesForDevices(['A', 'M'], [10])).toEqual([expect.objectContaining({ jobId: 20 })]);
    expect(prisma.scheduledJob.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { status: 'pending', id: { notIn: [10] } } }),
    );
  });

  it('sin dispositivos: [] sin consultar', async () => {
    const { service, prisma } = setup();
    expect(await service.seriesForDevices([])).toEqual([]);
    expect(prisma.scheduledJob.findMany).not.toHaveBeenCalled();
  });
});

describe('SeriesReservationsService.reservedSecondsForTask', () => {
  it('estimación del experimento resuelto + últimas 5 duraciones reales', async () => {
    const resolved = { acquisition: hiokiAcq, selector: { actuatorId: 'mux' }, preference: { ranges: [{ start: 1, stop: 2, points: 801, scale: 'LIN' }] } };
    // estimación: 2 canales × (1.5 + 1 + 801·0.01) = 21.02 → 22 s
    const { service, prisma } = setup({
      resolved,
      completed: [
        { startedAt: at(0), finishedAt: new Date(t0.getTime() + 100_000) },
        { startedAt: at(0), finishedAt: new Date(t0.getTime() + 50_000) },
      ],
    });
    expect(await service.reservedSecondsForTask(1, 2)).toBe(120); // ceil(100 × 1.2)
    expect(prisma.scheduledJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { taskId: 1, status: 'completed', startedAt: { not: null }, finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        take: 5,
      }),
    );
  });

  it('sin historial: al menos estimación + 60 s', async () => {
    const resolved = { acquisition: hiokiAcq, selector: { actuatorId: 'mux' }, preference: { ranges: [{ start: 1, stop: 2, points: 801, scale: 'LIN' }] } };
    const { service } = setup({ resolved });
    expect(await service.reservedSecondsForTask(1, 2)).toBe(82);
  });

  it('sin equipo de medición asignado: 400', async () => {
    const { service } = setup();
    await expect(service.reservedSecondsForTask(1, 1)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SeriesReservationsService.assertNoConflict', () => {
  const pending = [job({ id: 10, taskId: 1, label: 'Curado', task: { name: 'Losa' } })]; // t0 + 30k, 10 min
  const prefs = [{ taskId: 1, sensorDeviceId: 'A', channelSelectorDeviceId: null }];
  const candidate = { seriesStartAt: at(5), intervalMinutes: 30, firstIndex: 1, lastIndex: 4, reservedSeconds: 600 };

  it('choque en el mismo equipo: 409 con conflictos y suggestedStartAt', async () => {
    const { service } = setup({ pending, prefs });
    const err = await service.assertNoConflict(candidate, ['A']).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({
      message: 'La serie choca con otra medición programada en el mismo equipo',
      conflicts: [{ jobId: 10, taskName: 'Losa', label: 'Curado', at: at(5).toISOString() }],
      suggestedStartAt: at(10).toISOString(),
    });
  });

  it('misma hora en otro equipo: no lanza', async () => {
    const { service } = setup({ pending, prefs });
    await expect(service.assertNoConflict(candidate, ['B'])).resolves.toBeUndefined();
  });

  it('excludeJobIds ignora esas cadenas', async () => {
    const { service } = setup({ pending, prefs });
    await expect(service.assertNoConflict(candidate, ['A'], [10])).resolves.toBeUndefined();
  });

  it('serie que se solapa consigo misma: 400 con la duración reservada en minutos', async () => {
    const { service } = setup();
    await expect(
      service.assertNoConflict({ ...candidate, intervalMinutes: 5, reservedSeconds: 601 }, ['A']),
    ).rejects.toThrow(new BadRequestException('El intervalo es menor que la duración reservada de cada medición (11 min)'));
  });
});

describe('SeriesReservationsService.revalidateTask', () => {
  const prefs = [
    { taskId: 1, sensorDeviceId: 'A', channelSelectorDeviceId: null },
    { taskId: 2, sensorDeviceId: 'B', channelSelectorDeviceId: null },
  ];

  it('sin series pendientes: [] sin estimar', async () => {
    const { service } = setup({ prefs });
    const estimateFor = jest.fn(() => 10);
    expect(await service.revalidateTask(1, ['B'], estimateFor)).toEqual([]);
    expect(estimateFor).not.toHaveBeenCalled();
  });

  it('nuevos dispositivos chocan con otra tarea: 409', async () => {
    const pending = [job({ id: 10, taskId: 1 }), job({ id: 20, taskId: 2, task: { name: 'Otra' } })];
    const { service } = setup({ pending, prefs });
    await expect(service.revalidateTask(1, ['B'], () => 60)).rejects.toBeInstanceOf(ConflictException);
  });

  it('sin choque: devuelve el nuevo reservedSeconds por cadena (excluye las cadenas propias)', async () => {
    const pending = [job({ id: 10, taskId: 1, channelNumbers: [1, 2] }), job({ id: 11, taskId: 1, executionIndex: 2, repeatCount: 1 }), job({ id: 20, taskId: 2 })];
    const { service } = setup({ pending, prefs });
    const estimateFor = jest.fn((n: number) => n * 100);
    expect(await service.revalidateTask(1, ['A'], estimateFor)).toEqual([
      { jobId: 10, reservedSeconds: 260 },
      { jobId: 11, reservedSeconds: 160 },
    ]);
    expect(estimateFor).toHaveBeenCalledWith(2);
  });

  it('reserva nueva mayor que el intervalo: 400', async () => {
    const { service } = setup({ pending: [job({ id: 10, taskId: 1, intervalMinutes: 5 })], prefs });
    await expect(service.revalidateTask(1, ['A'], () => 600)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applyReservedSeconds actualiza solo cadenas pendientes', async () => {
    const { service, prisma } = setup();
    await service.applyReservedSeconds([{ jobId: 10, reservedSeconds: 260 }, { jobId: 11, reservedSeconds: 260 }, { jobId: 12, reservedSeconds: 90 }]);
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith({ where: { id: { in: [10, 11] }, status: 'pending' }, data: { reservedSeconds: 260 } });
    expect(prisma.scheduledJob.updateMany).toHaveBeenCalledWith({ where: { id: { in: [12] }, status: 'pending' }, data: { reservedSeconds: 90 } });
  });
});

describe('SeriesReservationsService.findConflicts', () => {
  it('pares de cadenas pendientes que comparten equipo y se solapan', async () => {
    const pending = [
      job({ id: 10, taskId: 1, task: { name: 'T1' } }),
      job({ id: 20, taskId: 2, seriesStartAt: at(5), task: { name: 'T2' } }),
      job({ id: 30, taskId: 3, task: { name: 'T3' } }), // mismo instante, otro equipo
      job({ id: 40, taskId: 1, seriesStartAt: at(15), task: { name: 'T1' } }), // mismo equipo, sin solape
    ];
    const prefs = [
      { taskId: 1, sensorDeviceId: 'A', channelSelectorDeviceId: 'M' },
      { taskId: 2, sensorDeviceId: 'B', channelSelectorDeviceId: 'M' },
      { taskId: 3, sensorDeviceId: 'C', channelSelectorDeviceId: null },
    ];
    const { service } = setup({ pending, prefs });
    expect(await service.findConflicts()).toEqual([
      { a: { jobId: 10, taskName: 'T1' }, b: { jobId: 20, taskName: 'T2' }, at: at(5).toISOString() },
    ]);
  });
});
