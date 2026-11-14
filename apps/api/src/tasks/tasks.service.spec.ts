import { TasksService } from './tasks.service';

const singleRow = {
  id: 1, takenAt: new Date(), takenBy: 'u1', start: null, stop: null, scale: null,
  sensorDeviceName: 'A', channelSelectorName: null, acquisition: { kind: 'single' },
  measurementChannels: [{ channelNumber: 3 }, { channelNumber: 1 }],
};
const sweepRow = {
  id: 2, takenAt: new Date(), takenBy: 'u1', start: 1, stop: 10, scale: 'LOG',
  sensorDeviceName: 'A', channelSelectorName: null,
  acquisition: { kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } },
  measurementChannels: [{ channelNumber: 1 }],
};
const singlePoints = {
  id: 1,
  data: [{ values: { temperature: [0, 23] } }],
  sensorValues: [{ name: 'temperature', unit: '°C', label: 'Temperatura' }],
};

/** Lista (sin data) y, aparte, la consulta acotada de lecturas puntuales (id, data, sensorValues). */
function setup(list: any[], singles: any[] = []) {
  const prisma = {
    measurement: {
      findMany: jest.fn<any, any>(async (args: any) => (args.select.data ? singles.filter((s) => args.where.id.in.includes(s.id)) : list)),
    },
  };
  const teamScope = { assertTaskInTeam: jest.fn() };
  const schedulingService = {};
  const experimentConfig = {};
  const service = new TasksService(prisma as any, teamScope as any, schedulingService as any, experimentConfig as any);
  return { service, prisma, teamScope };
}

describe('TasksService.getMeasurements (lista de mediciones de la tarea)', () => {
  it('la consulta de la lista no selecciona data e incluye scale y los canales (sin N+1)', async () => {
    const { service, prisma } = setup([sweepRow]);
    await service.getMeasurements(1, 'u1');
    const [args] = prisma.measurement.findMany.mock.calls[0];
    expect(args.select.data).toBeUndefined();
    expect(args.select.scale).toBe(true);
    expect(args.select.measurementChannels).toEqual({ select: { channelNumber: true } });
    // Solo barridos: no hace falta la segunda consulta
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(1);
  });

  it('expone channels (números medidos, ordenados) y scale', async () => {
    const { service } = setup([sweepRow, singleRow], [singlePoints]);
    const [sweep, single]: any = await service.getMeasurements(1, 'u1');
    expect(single.channels).toEqual([1, 3]);
    expect(sweep.scale).toBe('LOG');
    expect(single.scale).toBeNull();
  });

  it('lectura puntual (single): data y sensorValues desde UNA consulta acotada a las lecturas puntuales', async () => {
    const { service, prisma } = setup([sweepRow, singleRow], [singlePoints]);
    const [, m]: any = await service.getMeasurements(1, 'u1');
    expect(m.data).toEqual([{ values: { temperature: [0, 23] } }]);
    expect(m.sensorValues).toEqual([{ name: 'temperature', unit: '°C', label: 'Temperatura' }]);
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.measurement.findMany.mock.calls[1][0]).toEqual({
      where: { id: { in: [1] } },
      select: { id: true, data: true, sensorValues: true },
    });
  });

  it('barrido (sweep): NO incluye data ni sensorValues', async () => {
    const { service } = setup([sweepRow, singleRow], [singlePoints]);
    const [m]: any = await service.getMeasurements(2, 'u1');
    expect(m).not.toHaveProperty('data');
    expect(m).not.toHaveProperty('sensorValues');
  });
});
