import { ReportsService } from './reports.service';

const channel = {
  channelNumber: 1, channelAlias: 'Canal 1', concreteMix: null, hasEmulsifier: null,
  sampleAge: null, temperature: null, humidity: null, notes: null,
};
const singleRow = {
  id: 10, takenAt: new Date(), takenByName: 'U', presetName: 'cfg', scale: null,
  acquisition: { kind: 'single' }, watcherStatus: 'correct', watcherReason: null,
  measurementChannels: [channel],
};
const sweepRow = {
  id: 11, takenAt: new Date(), takenByName: 'U', presetName: 'cfg', scale: 'LOG',
  acquisition: { kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } },
  watcherStatus: 'correct', watcherReason: null,
  measurementChannels: [],
};
const singlePoints = {
  id: 10,
  data: [{ values: { temperature: [0, 23] } }],
  sensorValues: [{ name: 'temperature', unit: '°C' }],
};

const taskRow = {
  id: 1, name: 'Tarea', description: null,
  project: { uuid: 'p1', name: 'Proyecto' },
  taskPreferences: [],
};

/**
 * getTaskReport hace hasta tres findMany: la lista (sin data), las lecturas puntuales
 * (select { id, data, sensorValues }) y los candidatos a "latest" (select con measurementChannels).
 */
function setup(list: any[], singles: any[] = []) {
  const prisma = {
    task: { findUnique: jest.fn<any, any>(async () => taskRow) },
    measurement: {
      findMany: jest.fn<any, any>(async (args: any) => {
        if (args.select.data && !args.select.measurementChannels) return singles.filter((s) => args.where.id.in.includes(s.id));
        if (args.select.data) return []; // candidatos de "latest": sin datos en estos tests
        return list;
      }),
    },
  };
  const teamScope = { assertTaskInTeam: jest.fn() };
  const service = new ReportsService(prisma as any, teamScope as any);
  return { service, prisma, teamScope };
}

describe('ReportsService.getTaskReport — channels, data y sensorValues por medición', () => {
  it('la consulta de la lista no selecciona data', async () => {
    const { service, prisma } = setup([sweepRow]);
    await service.getTaskReport('u1', 1, { from: null, to: null });
    const [args] = prisma.measurement.findMany.mock.calls[0];
    expect(args.select.data).toBeUndefined();
    expect(args.select.scale).toBe(true);
  });

  it('lectura puntual (single): data y sensorValues desde una consulta acotada a las lecturas puntuales', async () => {
    const { service, prisma } = setup([sweepRow, singleRow], [singlePoints]);
    const report = await service.getTaskReport('u1', 1, { from: null, to: null });

    const single: any = report.measurements.find((m) => m.id === 10);
    expect(single.data).toEqual([{ values: { temperature: [0, 23] } }]);
    expect(single.sensorValues).toEqual([{ name: 'temperature', unit: '°C' }]);
    expect(single.channels.map((c: any) => c.channelNumber)).toEqual([1]);
    expect(prisma.measurement.findMany).toHaveBeenCalledWith({
      where: { id: { in: [10] } },
      select: { id: true, data: true, sensorValues: true },
    });
  });

  it('barrido (sweep): measurements[] NO incluye data ni sensorValues', async () => {
    const { service, prisma } = setup([sweepRow]);
    const report = await service.getTaskReport('u1', 1, { from: null, to: null });
    expect(report.measurements[0]).not.toHaveProperty('data');
    expect(report.measurements[0]).not.toHaveProperty('sensorValues');
    // sin lecturas puntuales no hay segunda consulta (solo la lista y los candidatos de "latest")
    expect(prisma.measurement.findMany.mock.calls.every(([a]: any) => !(a.select.data && !a.select.measurementChannels))).toBe(true);
  });
});
