import { BadRequestException } from '@nestjs/common';
import { MeasurementsService } from './measurements.service';

function setup() {
  const prisma = {
    measurement: {
      create: jest.fn(async ({ data }) => data),
      findUnique: jest.fn<any, any>(async () => null),
      findFirst: jest.fn<any, any>(async () => null),
      findMany: jest.fn(async () => []),
    },
  };
  const teamScope = {
    assertTaskInTeam: jest.fn(),
    assertMeasurementInTeam: jest.fn(),
    projectWhereForUser: jest.fn(async () => ({})),
  };
  const service = new MeasurementsService(prisma as any, teamScope as any);
  return { service, prisma };
}

const base = {
  taskId: 1, takenBy: '00000000-0000-0000-0000-000000000000', start: 1, stop: 2, points: 1,
  scale: 'LOG', sensorDeviceName: 'A', sensorDeviceIp: '10.0.0.1',
};

describe('MeasurementsService.create (POST /measurements)', () => {
  it('rechaza contenido inválido con 400 y no guarda', async () => {
    const { service, prisma } = setup();
    await expect(service.create({ ...base, sensorValues: [{ name: 'g', unit: 'S' }], data: [{ x: 1, values: { z: [1] } }] }, 'u1'))
      .rejects.toThrow(BadRequestException);
    expect(prisma.measurement.create).not.toHaveBeenCalled();
  });
  it('guarda un payload válido conservando solo { x, values } y el snapshot de barrido en frecuencia', async () => {
    const { service } = setup();
    const out: any = await service.create({
      ...base, sensorValues: [{ name: 'g', unit: 'S' }], data: [{ x: 1, values: { g: [1, 2] }, extra: 1 }],
    }, 'u1');
    expect(out.data).toEqual([{ x: 1, values: { g: [1, 2] } }]);
    expect(out.sensorValues).toEqual([{ name: 'g', unit: 'S' }]);
    expect(out.acquisition).toEqual({ kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } });
  });
});

describe('MeasurementsService.findOne / getLatest (canales medidos)', () => {
  it('findOne: expone channels (números ordenados) desde measurementChannels, sin tocar el resto del payload', async () => {
    const { service, prisma } = setup();
    prisma.measurement.findUnique.mockResolvedValue({
      id: 1, start: null, stop: null, acquisition: { kind: 'single' },
      measurementChannels: [{ channelNumber: 3 }, { channelNumber: 1 }],
    });
    const out: any = await service.findOne(1, 'u1');
    expect(out.channels).toEqual([1, 3]);
  });

  it('getLatest: expone channels además de la rica measurementChannels (con alias) ya existente', async () => {
    const { service, prisma } = setup();
    prisma.measurement.findFirst.mockResolvedValue({
      id: 2, start: null, stop: null, acquisition: { kind: 'single' },
      task: { id: 1, name: 'T', project: { uuid: 'p', name: 'P' } },
      measurementChannels: [{ channelNumber: 2, channelAlias: 'Canal 2' }],
    });
    const out: any = await service.getLatest('u1');
    expect(out.channels).toEqual([2]);
    expect(out.measurementChannels).toEqual([{ channelNumber: 2, channelAlias: 'Canal 2' }]);
  });
});
