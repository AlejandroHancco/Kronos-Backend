import { BadRequestException } from '@nestjs/common';
import { MeasurementsService } from './measurements.service';
import { SimulatedImpedancePlugin } from '../device-plugins/plugins/simulated-impedance.plugin';

function setup(resolved?: any) {
  const prisma = {
    measurement: { create: jest.fn(async ({ data }) => data) },
    taskChannel: { findMany: jest.fn(async () => []) },
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

describe('MeasurementsService.measureTask (selección de canal)', () => {
  it('con MUX y un equipo sin selección de canal: error claro antes de medir', async () => {
    const plugin = new SimulatedImpedancePlugin();
    const measureSpy = jest.spyOn(plugin, 'measureChannel');
    const { service, notifications } = setup({
      preference: { name: 'cfg', analyzerDevice: { name: 'Sim', type: 'sim-impedance', ip: null }, muxDevice: { name: 'Mux', ip: '10.0.0.2' } },
      plugin, description: plugin.describe(), channelRange: { min: 1, max: 1 }, valueMetas: [{ name: 'z', unit: 'Ω' }],
    });
    await expect(service.measureTask(1, 'u1', {
      ranges: [{ startFreq: 1, stopFreq: 2, points: 2, sweepType: 'LOG' }], selectedChannels: [1],
    })).rejects.toThrow(/tiene un MUX pero el equipo no admite selección de canal/);
    expect(measureSpy).not.toHaveBeenCalled();
    expect(notifications.notifyTeamMeasurementFailed).toHaveBeenCalled();
  });
});
