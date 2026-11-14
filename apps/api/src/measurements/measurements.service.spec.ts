import { BadRequestException } from '@nestjs/common';
import { MeasurementsService } from './measurements.service';

function setup(resolved?: any, plugins: { sensor?: unknown; selector?: unknown } = {}) {
  const prisma = {
    measurement: {
      create: jest.fn(async ({ data }) => data),
      findUnique: jest.fn<any, any>(async () => null),
      findFirst: jest.fn<any, any>(async () => null),
      findMany: jest.fn(async () => []),
    },
    taskChannel: { findMany: jest.fn(async () => []) },
    measurementChannel: { create: jest.fn(async () => ({})) },
    task: { findUnique: jest.fn(async () => null) },
  };
  const teamScope = {
    assertTaskInTeam: jest.fn(),
    getTeamId: jest.fn(async () => 't1'),
    assertMeasurementInTeam: jest.fn(),
    projectWhereForUser: jest.fn(async () => ({})),
  };
  const gateway = { measurementProgress: jest.fn(), measurementError: jest.fn(), measurementCompleted: jest.fn(), measurementComplete: jest.fn() };
  const notifications = {
    notifyTeamMeasurementSuccess: jest.fn(), notifyTeamMeasurementWarning: jest.fn(), notifyTeamMeasurementFailed: jest.fn(),
  };
  const experimentConfig = { assertChannels: jest.fn(async () => resolved), assertRanges: jest.fn() };
  const release = jest.fn();
  const deviceActivity = { beginMeasurement: jest.fn(async () => release) };
  const drivers = { sensor: jest.fn(() => plugins.sensor), actuator: jest.fn(() => plugins.selector) };
  const service = new MeasurementsService(
    prisma as any, teamScope as any, gateway as any, notifications as any, experimentConfig as any,
    deviceActivity as any, drivers as any,
  );
  return { service, prisma, gateway, notifications, deviceActivity, release, drivers };
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

describe('MeasurementsService.measureTask (sensor + selector de canal)', () => {
  const ranges = [
    { start: 1, stop: 2, points: 2, scale: 'LOG' },
    { start: 3, stop: 4, points: 3, scale: 'LOG' },
  ];
  const sensorCtx = { id: 's1', name: 'Sim', ip: null, configuration: {} };
  const selectorCtx = { id: 'm1', name: 'Mux', ip: '10.0.0.2', configuration: {} };

  function resolvedWith(calls: string[], withSelector: boolean) {
    const sensorPlugin = {
      getSensorData: jest.fn(async (_ctx: unknown, request: { start: number }) => {
        calls.push(`get:${request.start}`);
        return [{ x: request.start, values: { z: 1 } }];
      }),
    };
    const selectorPlugin = {
      setActuatorData: jest.fn(async (_ctx: unknown, _id: string, values: Record<string, number>) => {
        calls.push(`set:${values.channel}`);
      }),
    };
    return {
      sensorPlugin, selectorPlugin, plugins: { sensor: sensorPlugin, selector: selectorPlugin },
      resolved: {
        preference: {
          name: 'cfg', sensorDevice: { name: 'Sim', type: 'sim-impedance', ip: null },
          channelSelectorDevice: withSelector ? { name: 'Mux', type: 'kronos-mux-16', ip: '10.0.0.2' } : null,
        },
        sensor: { description: {}, context: sensorCtx },
        selector: withSelector
          ? { description: {}, context: selectorCtx, actuatorId: 'kronos-mux-16-channel', valueName: 'channel' }
          : null,
        channelRange: withSelector ? { min: 1, max: 16 } : { min: 1, max: 1 },
        valueMetas: [{ name: 'z', unit: 'Ω' }],
        acquisition: {
          kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia', rangeMinimum: 1, rangeMaximum: 10 },
          points: { minimum: 1, maximum: 801 }, scales: ['LIN', 'LOG'], secondsPerPoint: 0.01,
        },
      },
    };
  }

  it('con selector: activa cada canal y luego mide todos los rangos con el plugin del sensor', async () => {
    const calls: string[] = [];
    const { resolved, plugins, selectorPlugin, sensorPlugin } = resolvedWith(calls, true);
    const { service, prisma, drivers } = setup(resolved, plugins);
    const out = await service.measureTask(1, 'u1', { ranges, selectedChannels: [2, 1] });
    expect(out.channels).toEqual([1, 2]);
    expect(calls).toEqual(['set:1', 'get:1', 'get:3', 'set:2', 'get:1', 'get:3']);
    expect(selectorPlugin.setActuatorData).toHaveBeenCalledWith(selectorCtx, 'kronos-mux-16-channel', { channel: 1 });
    expect(sensorPlugin.getSensorData).toHaveBeenCalledWith(sensorCtx, { kind: 'sweep', start: 1, stop: 2, points: 2, scale: 'LOG' });
    expect(drivers.sensor).toHaveBeenCalledWith('sim-impedance');
    expect(drivers.actuator).toHaveBeenCalledWith('kronos-mux-16');
    expect(prisma.measurement.create.mock.calls[0][0].data).toMatchObject({ channelSelectorName: 'Mux', channelSelectorIp: '10.0.0.2', sensorDeviceName: 'Sim' });
  });

  it('guarda la copia genérica del barrido, el snapshot de adquisición y puntos { x, values }', async () => {
    const { resolved, plugins } = resolvedWith([], false);
    const { service, prisma, gateway } = setup(resolved, plugins);
    const out = await service.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
    const snapshot = { kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } };
    const data = prisma.measurement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ start: 1, stop: 4, points: 5, scale: 'LOG', acquisition: snapshot, sensorDeviceIp: null });
    expect(data.data.map((p: any) => p.x)).toEqual([1, 3]);
    expect(out.acquisition).toEqual(snapshot);
    expect(gateway.measurementCompleted.mock.calls[0][7]).toEqual(snapshot);
    expect(out.channels).toEqual([1]);
    expect(gateway.measurementCompleted.mock.calls[0][8]).toEqual([1]);
  });

  it('sin selector: solo getSensorData, una vez por rango', async () => {
    const calls: string[] = [];
    const { resolved, plugins, sensorPlugin } = resolvedWith(calls, false);
    const { service, prisma } = setup(resolved, plugins);
    await service.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
    expect(calls).toEqual(['get:1', 'get:3']);
    expect(sensorPlugin.getSensorData).toHaveBeenCalledTimes(2);
    expect(prisma.measurement.create.mock.calls[0][0].data).toMatchObject({ channelSelectorName: null, channelSelectorIp: null });
  });

  it('marca sensor y selector como ocupados durante la medición y los libera al terminar', async () => {
    const { resolved, plugins } = resolvedWith([], true);
    const { service, deviceActivity, release } = setup(resolved, plugins);
    await service.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
    expect(deviceActivity.beginMeasurement).toHaveBeenCalledWith(['s1', 'm1']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rango fuera de los límites del sensor: falla antes de tocar el plugin, con el mismo mensaje', async () => {
    const { resolved, plugins, sensorPlugin } = resolvedWith([], false);
    const { service, prisma } = setup(resolved, plugins);
    const badRanges = [{ start: 100, stop: 200, points: 2, scale: 'LOG' }]; // fuera de rangeMaximum: 10
    const message = 'Sim mide Frecuencia entre 1 Hz y 10 Hz';
    (service as any).experimentConfig.assertRanges = jest.fn(() => {
      throw new BadRequestException(message);
    });
    await expect(service.measureTask(1, 'u1', { ranges: badRanges, selectedChannels: [1] })).rejects.toThrow(
      new BadRequestException(message),
    );
    expect(sensorPlugin.getSensorData).not.toHaveBeenCalled();
    expect(prisma.measurement.create).not.toHaveBeenCalled();
  });

  it('adquisición "single": una lectura por canal sin rangos, sin columnas de barrido', async () => {
    const sensorCtx2 = { id: 's1', name: 'Temp', ip: null, configuration: {} };
    const sensorPlugin = {
      getSensorData: jest.fn(async () => [{ values: { temperature: 23, humidity: 50 } }]),
    };
    const resolved = {
      preference: {
        name: 'cfg', sensorDevice: { name: 'Temp', type: 'sim-temperature', ip: null },
        channelSelectorDevice: null,
      },
      sensor: { description: {}, context: sensorCtx2 },
      selector: null,
      channelRange: { min: 1, max: 1 },
      valueMetas: [{ name: 'temperature', unit: '°C' }, { name: 'humidity', unit: '%HR' }],
      acquisition: { kind: 'single', secondsPerReading: 1 },
    };
    const { service, prisma } = setup(resolved, { sensor: sensorPlugin });
    const out = await service.measureTask(1, 'u1', { ranges: [], selectedChannels: [1] });
    expect(sensorPlugin.getSensorData).toHaveBeenCalledTimes(1);
    expect(sensorPlugin.getSensorData).toHaveBeenCalledWith(sensorCtx2, { kind: 'single' });
    const data = prisma.measurement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ start: null, stop: null, points: null, scale: null, acquisition: { kind: 'single' } });
    expect(data.data).toHaveLength(1);
    expect('x' in data.data[0]).toBe(false);
    expect(out.acquisition).toEqual({ kind: 'single' });
    expect(out.channels).toEqual([1]);
  });

  it('libera los dispositivos aunque getSensorData o el guardado fallen', async () => {
    const { resolved, plugins, sensorPlugin } = resolvedWith([], false);
    sensorPlugin.getSensorData.mockRejectedValue(new Error('timeout'));
    const { service, prisma, deviceActivity, release } = setup(resolved, plugins);
    prisma.measurement.create.mockRejectedValue(new Error('db'));
    await expect(service.measureTask(1, 'u1', { ranges, selectedChannels: [1] })).rejects.toThrow('db');
    expect(deviceActivity.beginMeasurement).toHaveBeenCalledWith(['s1']);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
