import { TaskPreferencesService } from './task-preferences.service';
import { ExperimentConfigService } from '../device-plugins/experiment-config.service';
import { DevicePluginRegistry } from '../device-plugins/device-plugin.registry';
import { HiokiIm3570Plugin } from '../device-plugins/plugins/hioki-im3570.plugin';
import { SimulatedImpedancePlugin } from '../device-plugins/plugins/simulated-impedance.plugin';

const device = (id: string, type: string) => ({ id, name: id, type, ip: null, projectId: 'P' });
const savedPref = (analyzer: ReturnType<typeof device>, mux: ReturnType<typeof device> | null) => ({
  id: 1, taskId: 7, name: 'cfg', analyzerDeviceId: analyzer.id, muxDeviceId: mux?.id ?? null,
  analyzerDevice: analyzer, muxDevice: mux, ranges: [], createdAt: new Date(0), updatedAt: new Date(0),
});

function setup(pref: ReturnType<typeof savedPref>) {
  const registry = new DevicePluginRegistry(new HiokiIm3570Plugin(), new SimulatedImpedancePlugin());
  registry.onModuleInit();
  const prisma = {
    taskPreference: {
      findUnique: jest.fn(async () => pref),
      update: jest.fn(async () => pref),
    },
    scheduledJob: {
      findMany: jest.fn(async () => [
        { id: 11, channelNumbers: [1] },
        { id: 12, channelNumbers: [1, 5] },
        { id: 13, channelNumbers: [3] },
      ]),
    },
  };
  const experimentConfig = new ExperimentConfigService(prisma as any, registry);
  jest.spyOn(experimentConfig, 'assertValidConfig').mockResolvedValue(undefined);
  const teamScope = { assertTaskInTeam: jest.fn() };
  return { service: new TaskPreferencesService(prisma as any, teamScope as any, experimentConfig), prisma };
}

describe('TaskPreferencesService.updateTaskPreference (jobs programados)', () => {
  it('advierte los jobs pendientes con canales fuera del nuevo rango (sin MUX → solo canal 1)', async () => {
    const { service, prisma } = setup(savedPref(device('sim', 'sim-impedance'), null));
    const out = await service.updateTaskPreference(7, { analyzerDeviceId: 'sim', muxDeviceId: null }, 'u1');
    expect(prisma.scheduledJob.findMany).toHaveBeenCalledWith({
      where: { taskId: 7, status: 'pending' }, select: { id: true, channelNumbers: true },
    });
    expect(out.warnings).toEqual([
      expect.objectContaining({ code: 'scheduled_jobs_out_of_range', scheduledJobIds: [12, 13] }),
    ]);
    expect(out.warnings[0].message).toMatch(/mediciones programadas.*12, 13/);
  });

  it('sin jobs afectados: warnings vacío', async () => {
    const { service } = setup(savedPref(device('a', 'analyzer'), device('m', 'mux')));
    const out = await service.updateTaskPreference(7, { name: 'x' }, 'u1');
    expect(out.warnings).toEqual([]);
  });
});
