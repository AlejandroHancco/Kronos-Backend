import { HIOKI_IM3570, KRONOS_MUX_16, LaasCatalog, SIM_IMPEDANCE } from '@app/laas-catalog';
import { DeviceHealthService } from './device-health.service';

const catalog = new LaasCatalog([HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE]);

function setup(devices: any[], opts: { reachable?: boolean; leader?: boolean; deviceStatus?: jest.Mock } = {}) {
  const prisma = {
    device: { findMany: jest.fn(async () => devices), update: jest.fn(async () => ({})) },
  };
  const reachability = { check: jest.fn(async () => opts.reachable ?? true) };
  const realtime = { deviceStatus: opts.deviceStatus ?? jest.fn(async () => undefined) };
  const lockService = {
    runAsLeader: jest.fn(async (_name: string, _ttl: number, fn: () => Promise<void>) => {
      if (opts.leader === false) return false;
      await fn();
      return true;
    }),
  };
  const service = new DeviceHealthService(prisma as any, catalog, reachability as any, realtime as any, lockService as any);
  return { service, prisma, reachability, realtime, lockService };
}

describe('DeviceHealthService.checkAllDevices (worker)', () => {
  it('corre solo como líder "device-health" con TTL 25 000 ms', async () => {
    const { service, lockService, prisma } = setup([], { leader: false });
    await service.checkAllDevices();
    expect(lockService.runAsLeader).toHaveBeenCalledWith('device-health', 25_000, expect.any(Function));
    expect(prisma.device.findMany).not.toHaveBeenCalled();
  });

  it('un fallo al emitir el cambio de estado no salta el resto de dispositivos (deviceStatus se espera)', async () => {
    const devices = Array.from({ length: 7 }, (_, i) => ({
      id: `d${i + 1}`, ip: `10.0.0.${i + 1}`, type: 'hioki-im3570', status: 'offline', projectId: 'p1',
    }));
    const deviceStatus = jest.fn(async (id: string) => {
      if (id === 'd1') throw new Error('db down');
    });
    const { service, prisma } = setup(devices, { deviceStatus });
    const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    await service.checkAllDevices();

    expect(prisma.device.update).toHaveBeenCalledTimes(7);
    expect(deviceStatus).toHaveBeenCalledTimes(7);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('chequea dispositivos sin IP de tipos que no la requieren (según el catálogo)', async () => {
    const { service, prisma, reachability, realtime } = setup([{ id: 's1', ip: null, type: 'sim-impedance', status: 'offline', projectId: 'p1' }]);
    await service.checkAllDevices();
    expect((prisma.device.findMany.mock.calls[0] as any[])[0].where).toEqual({
      status: { not: 'archived' },
      OR: [{ ip: { not: null } }, { type: { in: ['sim-impedance'] } }],
    });
    expect(reachability.check).toHaveBeenCalledWith('sim-impedance', null);
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { status: 'online' } });
    expect(realtime.deviceStatus).toHaveBeenCalledWith('s1', 'p1', 'online');
  });

  it('un dispositivo sin tipo se chequea con tipo vacío (desconocido → offline)', async () => {
    const { service, prisma, reachability } = setup([{ id: 'n1', ip: '10.0.0.9', type: null, status: 'online', projectId: 'p1' }], { reachable: false });
    await service.checkAllDevices();
    expect(reachability.check).toHaveBeenCalledWith('', '10.0.0.9');
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 'n1' }, data: { status: 'offline' } });
  });

  it('sin cambio de estado no escribe ni emite', async () => {
    const { service, prisma, realtime } = setup([{ id: 'h1', ip: '10.0.0.1', type: 'hioki-im3570', status: 'online', projectId: 'p1' }]);
    await service.checkAllDevices();
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(realtime.deviceStatus).not.toHaveBeenCalled();
  });
});
