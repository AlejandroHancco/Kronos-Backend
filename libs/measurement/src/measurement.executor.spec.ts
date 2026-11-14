import { HttpException } from '@nestjs/common';
import { MeasurementExecutor } from './measurement.executor';

function setup(opts: { plugin?: any } = {}) {
  const plugin = opts.plugin ?? {
    selectChannel: jest.fn().mockResolvedValue(undefined),
    measureChannel: jest.fn().mockResolvedValue([
      { frequency: 100, values: { g: 1, b: 2 } },
      { frequency: 200, values: { g: 3, b: 4 } },
    ]),
  };
  const takenAt = new Date();
  const prisma: any = {
    taskPreference: {
      findFirst: jest.fn().mockResolvedValue({
        name: 'preset',
        analyzerDevice: { name: 'An', ip: '1.1.1.1', type: 'hioki' },
        muxDevice: { name: 'Mux', ip: '2.2.2.2' },
      }),
    },
    taskChannel: { findMany: jest.fn().mockResolvedValue([]) },
    measurement: { create: jest.fn().mockResolvedValue({ id: 42, takenAt }) },
    measurementChannel: { create: jest.fn().mockResolvedValue({}) },
    task: { findUnique: jest.fn().mockResolvedValue({ project: { name: 'P' } }) },
  };
  const teamScope: any = { getTeamId: jest.fn().mockResolvedValue('t1') };
  const publisher: any = {
    measurementProgress: jest.fn(),
    measurementCompleted: jest.fn(),
    measurementComplete: jest.fn(),
    measurementError: jest.fn(),
  };
  const writer: any = {
    notifyTeamMeasurementSuccess: jest.fn().mockResolvedValue(undefined),
    notifyTeamMeasurementWarning: jest.fn().mockResolvedValue(undefined),
    notifyTeamMeasurementFailed: jest.fn().mockResolvedValue(undefined),
  };
  const registry: any = { get: jest.fn().mockReturnValue(plugin) };
  const executor = new MeasurementExecutor(prisma, teamScope, publisher, writer, registry);
  return { executor, prisma, publisher, plugin, takenAt };
}

const range = { startFreq: 100, stopFreq: 200, points: 2, sweepType: 'LIN' as const };

describe('MeasurementExecutor.measureTask', () => {
  it('measures, persists one measurement and publishes progress/completed/complete', async () => {
    const { executor, prisma, publisher } = setup();

    const result = await executor.measureTask(1, 'u1', {
      ranges: [range],
      selectedChannels: [1],
      jobId: 'j',
    });

    expect(publisher.measurementProgress).toHaveBeenCalled();
    expect(publisher.measurementProgress.mock.calls[0][1]).toBe('j');
    expect(prisma.measurement.create).toHaveBeenCalledTimes(1);
    expect(publisher.measurementCompleted).toHaveBeenCalledWith(
      'u1',
      'j',
      42,
      expect.any(Date),
      2,
      expect.any(Array),
    );
    expect(publisher.measurementComplete).toHaveBeenCalledWith(1, expect.objectContaining({ jobId: 'j', measurementId: 42 }));
    expect(result.measurementId).toBe(42);
  });

  it('with empty selectedChannels publishes measurementError and rethrows', async () => {
    const { executor, publisher } = setup();

    await expect(
      executor.measureTask(1, 'u1', { ranges: [range], selectedChannels: [], jobId: 'j' }),
    ).rejects.toBeInstanceOf(HttpException);

    expect(publisher.measurementError).toHaveBeenCalledWith('u1', 'j', 'No channels selected for this task');
  });
});
