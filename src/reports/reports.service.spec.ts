import { ReportsService } from './reports.service';

function setup() {
  const prisma = {
    task: { findUnique: jest.fn<any, any>(async () => null) },
    measurement: { findMany: jest.fn<any, any>(async () => []) },
  };
  const teamScope = { assertTaskInTeam: jest.fn() };
  const service = new ReportsService(prisma as any, teamScope as any);
  return { service, prisma, teamScope };
}

const taskRow = {
  id: 1, name: 'Tarea', description: null,
  project: { uuid: 'p1', name: 'Proyecto' },
  taskPreferences: [],
};

describe('ReportsService.getTaskReport — channels y data por medición', () => {
  it('lectura puntual (single): measurements[] incluye data (un punto, chico)', async () => {
    const { service, prisma } = setup();
    prisma.task.findUnique.mockResolvedValue(taskRow);
    const singleRow = {
      id: 10, takenAt: new Date(), takenByName: 'U', presetName: 'cfg', scale: null,
      acquisition: { kind: 'single' }, watcherStatus: 'correct', watcherReason: null,
      data: [{ values: { temperature: [0, 23] } }],
      measurementChannels: [{
        channelNumber: 1, channelAlias: 'Canal 1', concreteMix: null, hasEmulsifier: null,
        sampleAge: null, temperature: null, humidity: null, notes: null,
      }],
    };
    // findMany se llama dos veces en getTaskReport: lista de mediciones y luego "latest" (candidatos)
    prisma.measurement.findMany.mockResolvedValueOnce([singleRow]).mockResolvedValueOnce([singleRow]);

    const report = await service.getTaskReport('u1', 1, { from: null, to: null });

    expect(report.measurements[0].data).toEqual([{ values: { temperature: [0, 23] } }]);
    // La medición ya expone los canales medidos vía su arreglo "channels" existente (rico, con alias)
    expect(report.measurements[0].channels.map((c: any) => c.channelNumber)).toEqual([1]);
  });

  it('barrido (sweep): measurements[] NO incluye data (se mantiene la forma actual del reporte)', async () => {
    const { service, prisma } = setup();
    prisma.task.findUnique.mockResolvedValue(taskRow);
    const sweepRow = {
      id: 11, takenAt: new Date(), takenByName: 'U', presetName: 'cfg', scale: 'LOG',
      acquisition: { kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } },
      watcherStatus: 'correct', watcherReason: null,
      data: [{ x: 1, values: { g: [1] } }],
      measurementChannels: [],
    };
    prisma.measurement.findMany.mockResolvedValueOnce([sweepRow]).mockResolvedValueOnce([]);

    const report = await service.getTaskReport('u1', 1, { from: null, to: null });

    expect(report.measurements[0].data).toBeUndefined();
  });
});
