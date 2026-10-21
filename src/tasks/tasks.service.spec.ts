import { TasksService } from './tasks.service';

function setup() {
  const prisma = {
    measurement: { findMany: jest.fn<any, any>(async () => []) },
  };
  const teamScope = { assertTaskInTeam: jest.fn() };
  const schedulingService = {};
  const experimentConfig = {};
  const service = new TasksService(prisma as any, teamScope as any, schedulingService as any, experimentConfig as any);
  return { service, prisma, teamScope };
}

describe('TasksService.getMeasurements (lista de mediciones de la tarea)', () => {
  it('expone channels (números medidos, ordenados) para cada medición, sin N+1', async () => {
    const { service, prisma } = setup();
    prisma.measurement.findMany.mockResolvedValue([
      {
        id: 1, takenAt: new Date(), takenBy: 'u1', start: null, stop: null,
        sensorDeviceName: 'A', channelSelectorName: null, acquisition: { kind: 'single' },
        measurementChannels: [{ channelNumber: 3 }, { channelNumber: 1 }],
        data: [{ values: { temperature: [23] } }],
      },
    ]);
    const [m]: any = await service.getMeasurements(1, 'u1');
    expect(m.channels).toEqual([1, 3]);
    // Una sola consulta: measurementChannels viene incluida en el mismo findMany (sin fan-out por id)
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(1);
  });

  it('lectura puntual (single): incluye data (un punto, chico)', async () => {
    const { service, prisma } = setup();
    prisma.measurement.findMany.mockResolvedValue([
      {
        id: 1, takenAt: new Date(), takenBy: 'u1', start: null, stop: null,
        sensorDeviceName: 'A', channelSelectorName: null, acquisition: { kind: 'single' },
        measurementChannels: [{ channelNumber: 1 }],
        data: [{ values: { temperature: [0, 23] } }],
      },
    ]);
    const [m]: any = await service.getMeasurements(1, 'u1');
    expect(m.data).toEqual([{ values: { temperature: [0, 23] } }]);
  });

  it('barrido (sweep): NO incluye data (se mantiene la forma actual de la lista)', async () => {
    const { service, prisma } = setup();
    prisma.measurement.findMany.mockResolvedValue([
      {
        id: 2, takenAt: new Date(), takenBy: 'u1', start: 1, stop: 10,
        sensorDeviceName: 'A', channelSelectorName: null,
        acquisition: { kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } },
        measurementChannels: [{ channelNumber: 1 }],
        data: [{ x: 1, values: { g: [1] } }],
      },
    ]);
    const [m]: any = await service.getMeasurements(2, 'u1');
    expect(m.data).toBeUndefined();
  });
});
