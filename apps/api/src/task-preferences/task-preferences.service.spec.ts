import { TaskPreferencesService } from './task-preferences.service';
import { ExperimentConfigService } from '@app/experiments';
import { HIOKI_IM3570, KRONOS_MUX_16, LaasCatalog, SIM_IMPEDANCE } from '@app/laas-catalog';

const device = (id: string, type: string) => ({ id, name: id, type, ip: null, projectId: 'P' });
const savedPref = (analyzer: ReturnType<typeof device>, mux: ReturnType<typeof device> | null) => ({
  id: 1, taskId: 7, name: 'cfg', sensorDeviceId: analyzer.id, channelSelectorDeviceId: mux?.id ?? null,
  sensorDevice: analyzer, channelSelectorDevice: mux, ranges: [], createdAt: new Date(0), updatedAt: new Date(0),
});

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
  jest.spyOn(experimentConfig, 'assertValidConfig').mockResolvedValue(undefined);
  const teamScope = { assertTaskInTeam: jest.fn() };
  return { service: new TaskPreferencesService(prisma as any, teamScope as any, experimentConfig), prisma };
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
