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
  const experimentConfig = { assertChannels: jest.fn(async () => resolved) };
  const service = new MeasurementsService(
    prisma as any, teamScope as any, gateway as any, kronos as any, notifications as any, experimentConfig as any,
  );
  return { service, prisma, notifications };
}

const base = {
  taskId: 1, takenBy: '00000000-0000-0000-0000-000000000000', startFreq: 1, stopFreq: 2, points: 1,
  sweepType: 'LOG', analyzerName: 'A', analyzerIp: '10.0.0.1',
};

describe('MeasurementsService.create (POST /measurements)', () => {
  it('rechaza contenido inválido con 400 y no guarda', async () => {
    const { service, prisma } = setup();
    await expect(service.create({ ...base, sensorValues: [{ name: 'g', unit: 'S' }], data: [{ frequency: 1, values: { z: [1] } }] }, 'u1'))
      .rejects.toThrow(BadRequestException);
    expect(prisma.measurement.create).not.toHaveBeenCalled();
  });
  it('guarda un payload válido conservando solo { frequency, values }', async () => {
    const { service } = setup();
    const out: any = await service.create({
      ...base, sensorValues: [{ name: 'g', unit: 'S' }], data: [{ frequency: 1, values: { g: [1, 2] }, extra: 1 }],
    }, 'u1');
    expect(out.data).toEqual([{ frequency: 1, values: { g: [1, 2] } }]);
    expect(out.sensorValues).toEqual([{ name: 'g', unit: 'S' }]);
  });
});

describe('MeasurementsService.measureTask (sensor + selector de canal)', () => {
  const ranges = [
    { startFreq: 1, stopFreq: 2, points: 2, sweepType: 'LOG' as const },
    { startFreq: 3, stopFreq: 4, points: 2, sweepType: 'LOG' as const },
  ];
  const sensorCtx = { id: 's1', name: 'Sim', ip: null, configuration: {} };
  const selectorCtx = { id: 'm1', name: 'Mux', ip: '10.0.0.2', configuration: {} };

  function resolvedWith(calls: string[], withSelector: boolean) {
    const sensorPlugin = {
      getSensorData: jest.fn(async (_ctx: unknown, sweep: { startFreq: number }) => {
        calls.push(`get:${sweep.startFreq}`);
        return [{ frequency: sweep.startFreq, values: { z: 1 } }];
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
          name: 'cfg', analyzerDevice: { name: 'Sim', type: 'sim-impedance', ip: null },
          muxDevice: withSelector ? { name: 'Mux', type: 'kronos-mux-16', ip: '10.0.0.2' } : null,
        },
        sensor: { plugin: sensorPlugin, description: {}, context: sensorCtx },
        selector: withSelector
          ? { plugin: selectorPlugin, description: {}, context: selectorCtx, actuatorId: 'kronos-mux-16-channel', valueName: 'channel' }
          : null,
        channelRange: withSelector ? { min: 1, max: 16 } : { min: 1, max: 1 },
        valueMetas: [{ name: 'z', unit: 'Ω' }],
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
    expect(sensorPlugin.getSensorData).toHaveBeenCalledWith(sensorCtx, ranges[0]);
    expect(prisma.measurement.create.mock.calls[0][0].data).toMatchObject({ muxName: 'Mux', muxIp: '10.0.0.2', analyzerName: 'Sim' });
  });

  it('sin selector: solo getSensorData, una vez por rango', async () => {
    const calls: string[] = [];
    const { resolved, sensorPlugin } = resolvedWith(calls, false);
    const { service, prisma } = setup(resolved);
    await service.measureTask(1, 'u1', { ranges, selectedChannels: [1] });
    expect(calls).toEqual(['get:1', 'get:3']);
    expect(sensorPlugin.getSensorData).toHaveBeenCalledTimes(2);
    expect(prisma.measurement.create.mock.calls[0][0].data).toMatchObject({ muxName: null, muxIp: null });
  });
});
