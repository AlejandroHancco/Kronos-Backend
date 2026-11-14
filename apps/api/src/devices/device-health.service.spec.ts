import { DeviceHealthService } from './device-health.service';

describe('DeviceHealthService.checkAllDevices', () => {
  it('un fallo al emitir el cambio de estado no salta el resto de dispositivos', async () => {
    const devices = Array.from({ length: 7 }, (_, i) => ({
      id: `d${i + 1}`, ip: `10.0.0.${i + 1}`, type: 'hioki-im3570', status: 'offline', projectId: 'p1',
    }));
    const prisma = {
      device: { findMany: jest.fn().mockResolvedValue(devices), update: jest.fn().mockResolvedValue({}) },
    };
    const devicesService = {
      checkReachable: jest.fn().mockResolvedValue(true),
      addresslessTypes: jest.fn().mockReturnValue(['sim-impedance']),
    };
    const gateway = {
      deviceStatus: jest.fn(async (id: string) => {
        if (id === 'd1') throw new Error('db down');
      }),
    };
    const service = new DeviceHealthService(prisma as any, devicesService as any, gateway as any);
    const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});

    await service.checkAllDevices();

    expect(prisma.device.update).toHaveBeenCalledTimes(7);
    expect(gateway.deviceStatus).toHaveBeenCalledTimes(7);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('chequea dispositivos sin IP de tipos que no la requieren', async () => {
    const prisma = {
      device: {
        findMany: jest.fn().mockResolvedValue([{ id: 's1', ip: null, type: 'sim-impedance', status: 'offline', projectId: 'p1' }]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const devicesService = { checkReachable: jest.fn().mockResolvedValue(true), addresslessTypes: jest.fn().mockReturnValue(['sim-impedance']) };
    const gateway = { deviceStatus: jest.fn() };
    await new DeviceHealthService(prisma as any, devicesService as any, gateway as any).checkAllDevices();
    expect(prisma.device.findMany.mock.calls[0][0].where).toEqual({
      status: { not: 'archived' },
      OR: [{ ip: { not: null } }, { type: { in: ['sim-impedance'] } }],
    });
    expect(devicesService.checkReachable).toHaveBeenCalledWith('sim-impedance', null);
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { status: 'online' } });
  });

  it('un dispositivo sin tipo se chequea con tipo vacío (desconocido → offline), sin suponer un modelo', async () => {
    const prisma = {
      device: {
        findMany: jest.fn().mockResolvedValue([{ id: 'n1', ip: '10.0.0.9', type: null, status: 'online', projectId: 'p1' }]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const devicesService = { checkReachable: jest.fn().mockResolvedValue(false), addresslessTypes: jest.fn().mockReturnValue([]) };
    const gateway = { deviceStatus: jest.fn() };
    await new DeviceHealthService(prisma as any, devicesService as any, gateway as any).checkAllDevices();
    expect(devicesService.checkReachable).toHaveBeenCalledWith('', '10.0.0.9');
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 'n1' }, data: { status: 'offline' } });
  });
});
