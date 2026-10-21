import { deviceIdsOf, runningJobDeviceIds, sharesDevice } from './device-usage';

describe('device-usage', () => {
  it('omite el MUX nulo', () => {
    expect(deviceIdsOf({ sensorDeviceId: 'A', channelSelectorDeviceId: null })).toEqual(['A']);
    expect(deviceIdsOf({ sensorDeviceId: 'A', channelSelectorDeviceId: 'M' })).toEqual(['A', 'M']);
  });
  it('dos tareas sin MUX con analizadores distintos NO chocan (antes null === null)', () => {
    expect(sharesDevice({ sensorDeviceId: 'A', channelSelectorDeviceId: null }, { sensorDeviceId: 'B', channelSelectorDeviceId: null })).toBe(false);
  });
  it('chocan si comparten analizador o MUX', () => {
    expect(sharesDevice({ sensorDeviceId: 'A', channelSelectorDeviceId: null }, { sensorDeviceId: 'A', channelSelectorDeviceId: 'M' })).toBe(true);
    expect(sharesDevice({ sensorDeviceId: 'A', channelSelectorDeviceId: 'M' }, { sensorDeviceId: 'B', channelSelectorDeviceId: 'M' })).toBe(true);
  });
  it('runningJobDeviceIds: analizador y MUX de los jobs running, sin MUX nulo', async () => {
    const prisma = {
      scheduledJob: { findMany: jest.fn(async () => [{ taskId: 1 }, { taskId: 2 }]) },
      taskPreference: {
        findMany: jest.fn(async () => [
          { sensorDeviceId: 'A', channelSelectorDeviceId: 'M' },
          { sensorDeviceId: 'B', channelSelectorDeviceId: null },
        ]),
      },
    };
    expect([...(await runningJobDeviceIds(prisma as any))].sort()).toEqual(['A', 'B', 'M']);
    expect(prisma.scheduledJob.findMany).toHaveBeenCalledWith({ where: { status: 'running' }, select: { taskId: true } });
    expect(prisma.taskPreference.findMany).toHaveBeenCalledWith({
      where: { taskId: { in: [1, 2] } }, select: { sensorDeviceId: true, channelSelectorDeviceId: true },
    });
  });
  it('runningJobDeviceIds: sin jobs running no consulta preferencias', async () => {
    const prisma = { scheduledJob: { findMany: jest.fn(async () => []) }, taskPreference: { findMany: jest.fn() } };
    expect((await runningJobDeviceIds(prisma as any)).size).toBe(0);
    expect(prisma.taskPreference.findMany).not.toHaveBeenCalled();
  });
});
