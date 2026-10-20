import { DeviceHealthService } from './device-health.service';

describe('DeviceHealthService.checkAllDevices', () => {
  it('un fallo al emitir el cambio de estado no salta el resto de dispositivos', async () => {
    const devices = Array.from({ length: 7 }, (_, i) => ({
      id: `d${i + 1}`, ip: `10.0.0.${i + 1}`, type: 'analyzer', status: 'offline', projectId: 'p1',
    }));
    const prisma = {
      device: { findMany: jest.fn().mockResolvedValue(devices), update: jest.fn().mockResolvedValue({}) },
    };
    const devicesService = { checkReachable: jest.fn().mockResolvedValue(true) };
    const gateway = {
      emitDeviceStatusChanged: jest.fn(async (id: string) => {
        if (id === 'd1') throw new Error('db down');
      }),
    };
    const service = new DeviceHealthService(prisma as any, devicesService as any, gateway as any);
    const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

    await service.checkAllDevices();

    expect(prisma.device.update).toHaveBeenCalledTimes(7);
    expect(gateway.emitDeviceStatusChanged).toHaveBeenCalledTimes(7);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
