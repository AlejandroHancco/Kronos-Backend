import { ConflictException } from '@nestjs/common';
import { TaskPreferencesService } from './task-preferences.service';
import { ExperimentConfigService } from '@app/experiments';
import { HIOKI_IM3570, KRONOS_MUX_16, LaasCatalog, SIM_IMPEDANCE } from '@app/laas-catalog';

const device = (id: string, type: string) => ({ id, name: id, type, ip: null, projectId: 'P' });
const savedPref = (analyzer: ReturnType<typeof device>, mux: ReturnType<typeof device> | null) => ({
  id: 1, taskId: 7, name: 'cfg', sensorDeviceId: analyzer.id, channelSelectorDeviceId: mux?.id ?? null,
  sensorDevice: analyzer, channelSelectorDevice: mux, ranges: [], createdAt: new Date(0), updatedAt: new Date(0),
});

const hiokiAcq = {
  kind: 'sweep' as const,
  variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia', rangeMinimum: 4, rangeMaximum: 5000000 },
  points: { minimum: 1, maximum: 801 },
  scales: ['LIN', 'LOG'] as const,
  secondsPerPoint: 0.01,
};

function setup(pref: ReturnType<typeof savedPref> | null) {
  const catalog = new LaasCatalog([HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE]);
  const prisma = {
    taskPreference: {
      findUnique: jest.fn(async () => pref),
      update: jest.fn(async () => pref),
      create: jest.fn(async () => pref ?? savedPref(device('sim', 'sim-impedance'), null)),
    },
    scheduledJob: {
      findMany: jest.fn(async () => [
        { id: 11, channelNumbers: [1] },
        { id: 12, channelNumbers: [1, 5] },
        { id: 13, channelNumbers: [3] },
      ]),
    },
  };
  const experimentConfig = new ExperimentConfigService(prisma as any, catalog);
  jest.spyOn(experimentConfig, 'assertValidConfig').mockResolvedValue(hiokiAcq as any);
  const teamScope = { assertTaskInTeam: jest.fn() };
  const reservations = {
    revalidateTask: jest.fn(async (): Promise<Array<{ jobId: number; reservedSeconds: number }>> => []),
    applyReservedSeconds: jest.fn(async () => undefined),
  };
  return {
    service: new TaskPreferencesService(prisma as any, teamScope as any, experimentConfig, reservations as any),
    prisma,
    reservations,
  };
}

describe('TaskPreferencesService.createTaskPreference / updateTaskPreference (validación de rangos)', () => {
  it('create: pasa dto.ranges a assertValidConfig', async () => {
    const { service } = setup(null);
    const ranges = [{ order: 0, start: 1, stop: 2, points: 10, scale: 'LIN' }];
    await service.createTaskPreference(7, { name: 'cfg', sensorDeviceId: 'sim', ranges } as any, 'u1');
    const spy = (service as any).experimentConfig.assertValidConfig;
    expect(spy).toHaveBeenCalledWith(7, 'sim', null, [{ start: 1, stop: 2, points: 10, scale: 'LIN' }]);
  });

  it('create: aplica los valores por defecto de la BD (points 801, scale LIN) cuando faltan', async () => {
    const { service } = setup(null);
    const ranges = [{ order: 0, start: 1, stop: 2 }];
    await service.createTaskPreference(7, { name: 'cfg', sensorDeviceId: 'sim', ranges } as any, 'u1');
    const spy = (service as any).experimentConfig.assertValidConfig;
    expect(spy).toHaveBeenCalledWith(7, 'sim', null, [{ start: 1, stop: 2, points: 801, scale: 'LIN' }]);
  });

  it('update: sin ranges en el request, usa los rangos guardados', async () => {
    const stored = { ...savedPref(device('sim', 'sim-impedance'), null), ranges: [{ id: 1, order: 0, start: 1, stop: 2, points: 50, scale: 'LOG' }] } as any;
    const { service } = setup(stored);
    await service.updateTaskPreference(7, { name: 'otro' } as any, 'u1');
    const spy = (service as any).experimentConfig.assertValidConfig;
    expect(spy).toHaveBeenCalledWith(7, 'sim', null, [{ start: 1, stop: 2, points: 50, scale: 'LOG' }]);
  });

  it('update: cambia el equipo de medición, se valida con la adquisición del nuevo dispositivo', async () => {
    const stored = { ...savedPref(device('sim', 'sim-impedance'), null), ranges: [{ id: 1, order: 0, start: 1, stop: 2, points: 50, scale: 'LOG' }] } as any;
    const { service } = setup(stored);
    await service.updateTaskPreference(7, { sensorDeviceId: 'hioki' } as any, 'u1');
    const spy = (service as any).experimentConfig.assertValidConfig;
    expect(spy).toHaveBeenCalledWith(7, 'hioki', null, [{ start: 1, stop: 2, points: 50, scale: 'LOG' }]);
  });
});

describe('TaskPreferencesService.updateTaskPreference (jobs programados)', () => {
  it('advierte los jobs pendientes con canales fuera del nuevo rango (sin MUX → solo canal 1)', async () => {
    const { service, prisma } = setup(savedPref(device('sim', 'sim-impedance'), null));
    const out = await service.updateTaskPreference(7, { sensorDeviceId: 'sim', channelSelectorDeviceId: null }, 'u1');
    expect(prisma.scheduledJob.findMany).toHaveBeenCalledWith({
      where: { taskId: 7, status: 'pending' }, select: { id: true, channelNumbers: true },
    });
    expect(out.warnings).toEqual([
      expect.objectContaining({ code: 'scheduled_jobs_out_of_range', scheduledJobIds: [12, 13] }),
    ]);
    expect(out.warnings[0].message).toMatch(/mediciones programadas.*12, 13/);
  });

  it('sin jobs afectados: warnings vacío', async () => {
    const { service } = setup(savedPref(device('a', 'hioki-im3570'), device('m', 'kronos-mux-16')));
    const out = await service.updateTaskPreference(7, { name: 'x' }, 'u1');
    expect(out.warnings).toEqual([]);
  });
});

describe('TaskPreferencesService.updateTaskPreference (revalidación de series pendientes)', () => {
  const stored = () => ({ ...savedPref(device('a', 'hioki-im3570'), null), ranges: [{ id: 1, order: 0, start: 1, stop: 2, points: 801, scale: 'LIN' }] }) as any;

  it('revalida con los nuevos dispositivos y la estimación de la nueva configuración', async () => {
    const { service, reservations } = setup(stored());
    await service.updateTaskPreference(7, { sensorDeviceId: 'b', channelSelectorDeviceId: 'm', ranges: [{ order: 0, start: 1, stop: 2, points: 101 }] } as any, 'u1');
    expect(reservations.revalidateTask).toHaveBeenCalledWith(7, ['b', 'm'], expect.any(Function));
    const estimateFor = (reservations.revalidateTask.mock.calls[0] as any[])[2] as (n: number) => number;
    // 2 canales × (1.5 cambio + 1 setup + 101·0.01) = 7.02 → 8 s
    expect(estimateFor(2)).toBe(8);
  });

  it('choque con otra serie: 409 y la preferencia no se guarda', async () => {
    const { service, prisma, reservations } = setup(stored());
    reservations.revalidateTask.mockRejectedValueOnce(new ConflictException({ message: 'choca', conflicts: [], suggestedStartAt: null }));
    await expect(service.updateTaskPreference(7, { sensorDeviceId: 'b' } as any, 'u1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.taskPreference.update).not.toHaveBeenCalled();
    expect(reservations.applyReservedSeconds).not.toHaveBeenCalled();
  });

  it('sin choque: guarda y actualiza reservedSeconds de las series pendientes de la tarea', async () => {
    const { service, prisma, reservations } = setup(stored());
    reservations.revalidateTask.mockResolvedValueOnce([{ jobId: 11, reservedSeconds: 300 }]);
    await service.updateTaskPreference(7, { channelSelectorDeviceId: 'm' } as any, 'u1');
    expect(reservations.revalidateTask).toHaveBeenCalledWith(7, ['a', 'm'], expect.any(Function));
    expect(prisma.taskPreference.update).toHaveBeenCalled();
    expect(reservations.applyReservedSeconds).toHaveBeenCalledWith([{ jobId: 11, reservedSeconds: 300 }]);
  });
});
