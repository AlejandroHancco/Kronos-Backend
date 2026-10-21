import { BadRequestException } from '@nestjs/common';
import { MeasurementsService } from './measurements.service';

function setup(resolved?: any) {
  const prisma = {
    measurement: { create: jest.fn(async ({ data }) => data) },
    taskChannel: { findMany: jest.fn(async () => []) },
    measurementChannel: { create: jest.fn(async () => ({})) },
    task: { findUnique: jest.fn(async () => null) },
  };
  const teamScope = { assertTaskInTeam: jest.fn(), getTeamId: jest.fn(async () => 't1') };
  const gateway = { emitMeasurementProgress: jest.fn(), emitMeasurementError: jest.fn(), emitMeasurementCompleted: jest.fn() };
  const kronos = { emitMeasurementComplete: jest.fn() };
  const notifications = {
    notifyTeamMeasurementSuccess: jest.fn(), notifyTeamMeasurementWarning: jest.fn(), notifyTeamMeasurementFailed: jest.fn(),
  };
  const experimentConfig = { assertChannels: jest.fn(async () => resolved), assertRanges: jest.fn() };
  const release = jest.fn();
  const deviceActivity = { beginMeasurement: jest.fn(async () => release) };
  const service = new MeasurementsService(
    prisma as any, teamScope as any, gateway as any, kronos as any, notifications as any, experimentConfig as any,
    deviceActivity as any,
  );
  return { service, prisma, gateway, notifications, deviceActivity, release };
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
      sensorPlugin, selectorPlugin,
      resolved: {
        preference: {
          name: 'cfg', sensorDevice: { name: 'Sim', type: 'sim-impedance', ip: null },
          channelSelectorDevice: withSelector ? { name: 'Mux', type: 'kronos-mux-16', ip: '10.0.0.2' } : null,
        },
        sensor: { plugin: sensorPlugin, description: {}, context: sensorCtx },
        selector: withSelector
          ? { plugin: selectorPlugin, description: {}, context: selectorCtx, actuatorId: 'kronos-mux-16-channel', valueName: 'channel' }
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
    const { resolved, selectorPlugin, sensorPlugin } = resolvedWith(calls, true);
    const { service, prisma } = setup(resolved);
    await service.measureTask(1, 'u1', { ranges, selectedChannels: [2, 1] });
    expect(calls).toEqual(['set:1', 'get:1', 'get:3', 'set:2', 'get:1', 'get:3']);
    expect(selectorPlugin.setActuatorData).toHaveBeenCalledWith(selectorCtx, 'kronos-mux-16-channel', { channel: 1 });
    expect(sensorPlugin.getSensorData).toHaveBeenCalledWith(sensorCtx, { kind: 'sweep', start: 1, stop: 2, points: 2, scale: 'LOG' });
    expect(prisma.measurement.create.mock.calls[0][0].data).toMatchObject({ channelSelectorName: 'Mux', channelSelectorIp: '10.0.0.2', sensorDeviceName: 'Sim' });
  });

  it('guarda la copia genérica del barrido, el snapshot de adquisición y puntos { x, values }', async () => {
    const { resolved } = resolvedWith([], false);
    const { service, prisma, gateway } = setup(resolved);
    const out = await service.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
    const snapshot = { kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } };
    const data = prisma.measurement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ start: 1, stop: 4, points: 5, scale: 'LOG', acquisition: snapshot, sensorDeviceIp: null });
    expect(data.data.map((p: any) => p.x)).toEqual([1, 3]);
    expect(out.acquisition).toEqual(snapshot);
    expect(gateway.emitMeasurementCompleted.mock.calls[0][7]).toEqual(snapshot);
  });

  it('sin selector: solo getSensorData, una vez por rango', async () => {
    const calls: string[] = [];
    const { resolved, sensorPlugin } = resolvedWith(calls, false);
    const { service, prisma } = setup(resolved);
    await service.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
    expect(calls).toEqual(['get:1', 'get:3']);
    expect(sensorPlugin.getSensorData).toHaveBeenCalledTimes(2);
    expect(prisma.measurement.create.mock.calls[0][0].data).toMatchObject({ channelSelectorName: null, channelSelectorIp: null });
  });

  it('marca sensor y selector como ocupados durante la medición y los libera al terminar', async () => {
    const { resolved } = resolvedWith([], true);
    const { service, deviceActivity, release } = setup(resolved);
    await service.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
    expect(deviceActivity.beginMeasurement).toHaveBeenCalledWith(['s1', 'm1']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rango fuera de los límites del sensor: falla antes de tocar el plugin, con el mismo mensaje', async () => {
    const { resolved, sensorPlugin } = resolvedWith([], false);
    const { service, prisma } = setup(resolved);
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
      sensor: { plugin: sensorPlugin, description: {}, context: sensorCtx2 },
      selector: null,
      channelRange: { min: 1, max: 1 },
      valueMetas: [{ name: 'temperature', unit: '°C' }, { name: 'humidity', unit: '%HR' }],
      acquisition: { kind: 'single', secondsPerReading: 1 },
    };
    const { service, prisma } = setup(resolved);
    const out = await service.measureTask(1, 'u1', { ranges: [], selectedChannels: [1] });
    expect(sensorPlugin.getSensorData).toHaveBeenCalledTimes(1);
    expect(sensorPlugin.getSensorData).toHaveBeenCalledWith(sensorCtx2, { kind: 'single' });
    const data = prisma.measurement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ start: null, stop: null, points: null, scale: null, acquisition: { kind: 'single' } });
    expect(data.data).toHaveLength(1);
    expect('x' in data.data[0]).toBe(false);
    expect(out.acquisition).toEqual({ kind: 'single' });
  });

  it('libera los dispositivos aunque getSensorData o el guardado fallen', async () => {
    const { resolved, sensorPlugin } = resolvedWith([], false);
    sensorPlugin.getSensorData.mockRejectedValue(new Error('timeout'));
    const { service, prisma, deviceActivity, release } = setup(resolved);
    prisma.measurement.create.mockRejectedValue(new Error('db'));
    await expect(service.measureTask(1, 'u1', { ranges, selectedChannels: [1] })).rejects.toThrow('db');
    expect(deviceActivity.beginMeasurement).toHaveBeenCalledWith(['s1']);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
