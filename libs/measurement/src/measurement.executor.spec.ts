import { BadRequestException } from '@nestjs/common';
import { KRONOS_MUX_16 } from '@app/laas-catalog';
import { MeasurementExecutor } from './measurement.executor';

function setup(resolved?: any, plugins: { sensor?: unknown; selector?: unknown } = {}) {
  const prisma = {
    measurement: { create: jest.fn(async ({ data }) => data) },
    taskChannel: { findMany: jest.fn(async () => []) },
    measurementChannel: { create: jest.fn(async () => ({})) },
    task: { findUnique: jest.fn(async () => null) },
  };
  const teamScope = { getTeamId: jest.fn(async () => 't1') };
  const gateway = { measurementProgress: jest.fn(), measurementError: jest.fn(), measurementCompleted: jest.fn(), measurementComplete: jest.fn() };
  const notifications = {
    notifyTeamMeasurementSuccess: jest.fn(), notifyTeamMeasurementWarning: jest.fn(), notifyTeamMeasurementFailed: jest.fn(),
  };
  const experimentConfig = { assertChannels: jest.fn(async () => resolved), assertRanges: jest.fn() };
  const drivers = { sensor: jest.fn(() => plugins.sensor), actuator: jest.fn(() => plugins.selector) };
  const liveValues = { record: jest.fn(async (_id: string, _values: Record<string, number>): Promise<void> => undefined) };
  const executor = new MeasurementExecutor(
    prisma as any, teamScope as any, gateway as any, notifications as any, experimentConfig as any, drivers as any,
    liveValues as any,
  );
  return { executor, prisma, gateway, notifications, drivers, liveValues };
}

describe('MeasurementExecutor.measureTask (sensor + selector de canal)', () => {
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
    const { executor, prisma, drivers } = setup(resolved, plugins);
    const out = await executor.measureTask(1, 'u1', { ranges, selectedChannels: [2, 1] });
    expect(out.channels).toEqual([1, 2]);
    expect(calls).toEqual(['set:1', 'get:1', 'get:3', 'set:2', 'get:1', 'get:3']);
    expect(selectorPlugin.setActuatorData).toHaveBeenCalledWith(selectorCtx, 'kronos-mux-16-channel', { channel: 1 });
    expect(sensorPlugin.getSensorData).toHaveBeenCalledWith(sensorCtx, { kind: 'sweep', start: 1, stop: 2, points: 2, scale: 'LOG' });
    expect(drivers.sensor).toHaveBeenCalledWith('sim-impedance');
    expect(drivers.actuator).toHaveBeenCalledWith('kronos-mux-16');
    expect(prisma.measurement.create.mock.calls[0][0].data).toMatchObject({ channelSelectorName: 'Mux', channelSelectorIp: '10.0.0.2', sensorDeviceName: 'Sim' });
  });

  it('ledger: tras cada setActuatorData registra el canal en LiveValueStore si el modelo declara ese parámetro live', async () => {
    const calls: string[] = [];
    const { resolved, plugins } = resolvedWith(calls, true);
    resolved.selector!.description = KRONOS_MUX_16.description as any;
    const { executor, liveValues } = setup(resolved, plugins);
    liveValues.record.mockImplementation(async (_id: string, values: any) => { calls.push(`record:${values.channel}`); });
    await executor.measureTask(1, 'u1', { ranges, selectedChannels: [2, 1] });
    expect(calls).toEqual(['set:1', 'record:1', 'get:1', 'get:3', 'set:2', 'record:2', 'get:1', 'get:3']);
    expect(liveValues.record).toHaveBeenNthCalledWith(1, 'm1', { channel: 1 });
    expect(liveValues.record).toHaveBeenNthCalledWith(2, 'm1', { channel: 2 });
  });

  it('ledger: no registra nada si el selector no declara un parámetro live con ese nombre', async () => {
    const { resolved, plugins } = resolvedWith([], true);
    resolved.selector!.description = { configuration: [{ name: 'channel', storage: 'persisted' }] } as any;
    const { executor, liveValues } = setup(resolved, plugins);
    await executor.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
    expect(liveValues.record).not.toHaveBeenCalled();
  });

  it('ledger: un fallo al registrar no invalida el canal medido', async () => {
    const { resolved, plugins, sensorPlugin } = resolvedWith([], true);
    resolved.selector!.description = KRONOS_MUX_16.description as any;
    const { executor, liveValues } = setup(resolved, plugins);
    liveValues.record.mockRejectedValue(new Error('redis down'));
    const out = await executor.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
    expect(sensorPlugin.getSensorData).toHaveBeenCalledTimes(2);
    expect(out.totalPoints).toBe(2);
  });

  it('guarda la copia genérica del barrido, el snapshot de adquisición y puntos { x, values }', async () => {
    const { resolved, plugins } = resolvedWith([], false);
    const { executor, prisma, gateway } = setup(resolved, plugins);
    const out = await executor.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
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
    const { executor, prisma } = setup(resolved, plugins);
    await executor.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
    expect(calls).toEqual(['get:1', 'get:3']);
    expect(sensorPlugin.getSensorData).toHaveBeenCalledTimes(2);
    expect(prisma.measurement.create.mock.calls[0][0].data).toMatchObject({ channelSelectorName: null, channelSelectorIp: null });
  });

  it('rango fuera de los límites del sensor: falla antes de tocar el plugin, con el mismo mensaje', async () => {
    const { resolved, plugins, sensorPlugin } = resolvedWith([], false);
    const { executor, prisma } = setup(resolved, plugins);
    const badRanges = [{ start: 100, stop: 200, points: 2, scale: 'LOG' }]; // fuera de rangeMaximum: 10
    const message = 'Sim mide Frecuencia entre 1 Hz y 10 Hz';
    (executor as any).experimentConfig.assertRanges = jest.fn(() => {
      throw new BadRequestException(message);
    });
    await expect(executor.measureTask(1, 'u1', { ranges: badRanges, selectedChannels: [1] })).rejects.toThrow(
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
    const { executor, prisma } = setup(resolved, { sensor: sensorPlugin });
    const out = await executor.measureTask(1, 'u1', { ranges: [], selectedChannels: [1] });
    expect(sensorPlugin.getSensorData).toHaveBeenCalledTimes(1);
    expect(sensorPlugin.getSensorData).toHaveBeenCalledWith(sensorCtx2, { kind: 'single' });
    const data = prisma.measurement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ start: null, stop: null, points: null, scale: null, acquisition: { kind: 'single' } });
    expect(data.data).toHaveLength(1);
    expect('x' in data.data[0]).toBe(false);
    expect(out.acquisition).toEqual({ kind: 'single' });
    expect(out.channels).toEqual([1]);
  });

  it('publica el error y notifica al equipo cuando getSensorData o el guardado fallan', async () => {
    const { resolved, plugins, sensorPlugin } = resolvedWith([], false);
    sensorPlugin.getSensorData.mockRejectedValue(new Error('timeout'));
    const { executor, prisma, gateway, notifications } = setup(resolved, plugins);
    prisma.measurement.create.mockRejectedValue(new Error('db'));
    await expect(executor.measureTask(1, 'u1', { ranges, selectedChannels: [1] })).rejects.toThrow('db');
    expect(gateway.measurementError).toHaveBeenCalledWith('u1', expect.any(String), 'db');
    expect(notifications.notifyTeamMeasurementFailed).toHaveBeenCalled();
  });
});
