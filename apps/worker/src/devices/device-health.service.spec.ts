import RedisMock from 'ioredis-mock';
import { HIOKI_IM3570, KRONOS_MUX_16, LaasCatalog, SIM_IMPEDANCE } from '@app/laas-catalog';
import { DeviceHealthService } from './device-health.service';
import { DeviceAlerts } from './device-alerts';

const catalog = new LaasCatalog([HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE]);

// ioredis-mock comparte los datos entre instancias del mismo host: cada test empieza limpio
beforeEach(async () => {
  await new RedisMock().flushall();
});

function setup(devices: any[], opts: { reachable?: boolean; leader?: boolean; deviceStatus?: jest.Mock } = {}) {
  const prisma = {
    device: {
      findMany: jest.fn(async () => devices.map((d) => ({ ...d }))),
      // simula la BD: el siguiente chequeo ve el estado escrito
      update: jest.fn(async ({ where, data }: any) => {
        const d = devices.find((x) => x.id === where.id);
        if (d) Object.assign(d, data);
        return {};
      }),
    },
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
  const redis = new RedisMock();
  const alerts = { deviceOffline: jest.fn(async () => undefined), deviceOnline: jest.fn(async () => undefined) };
  const service = new DeviceHealthService(
    prisma as any,
    catalog,
    reachability as any,
    realtime as any,
    lockService as any,
    redis as any,
    alerts as any,
  );
  return { service, prisma, reachability, realtime, lockService, redis, alerts };
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
      id: `d${i + 1}`, name: `D${i + 1}`, ip: `10.0.0.${i + 1}`, type: 'hioki-im3570', status: 'offline', projectId: 'p1',
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
    const { service, prisma, reachability, realtime } = setup([{ id: 's1', name: 'Sim', ip: null, type: 'sim-impedance', status: 'offline', projectId: 'p1' }]);
    await service.checkAllDevices();
    expect((prisma.device.findMany.mock.calls[0] as any[])[0].where).toEqual({
      status: { not: 'archived' },
      OR: [{ ip: { not: null } }, { type: { in: ['sim-impedance'] } }],
    });
    expect(reachability.check).toHaveBeenCalledWith('sim-impedance', null);
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { status: 'online' } });
    expect(realtime.deviceStatus).toHaveBeenCalledWith('s1', 'p1', 'online');
  });

  it('un dispositivo sin tipo se chequea con tipo vacío (desconocido → offline tras dos chequeos)', async () => {
    const { service, prisma, reachability } = setup([{ id: 'n1', name: 'N', ip: '10.0.0.9', type: null, status: 'online', projectId: 'p1' }], { reachable: false });
    await service.checkAllDevices();
    await service.checkAllDevices();
    expect(reachability.check).toHaveBeenCalledWith('', '10.0.0.9');
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 'n1' }, data: { status: 'offline' } });
  });

  it('sin cambio de estado no escribe ni emite', async () => {
    const { service, prisma, realtime } = setup([{ id: 'h1', name: 'H', ip: '10.0.0.1', type: 'hioki-im3570', status: 'online', projectId: 'p1' }]);
    await service.checkAllDevices();
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(realtime.deviceStatus).not.toHaveBeenCalled();
  });
});

describe('DeviceHealthService: desconexión con rebote y alertas', () => {
  const hioki = () => ({ id: 'h1', name: 'Hioki 1', ip: '10.0.0.1', type: 'hioki-im3570', status: 'online', projectId: 'p1' });

  it('un fallo aislado mantiene online (contador en health:fail:<id>) y un éxito lo reinicia', async () => {
    const { service, prisma, reachability, redis, alerts } = setup([hioki()]);
    reachability.check.mockResolvedValueOnce(false);
    await service.checkAllDevices();
    expect(await redis.get('health:fail:h1')).toBe('1');
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(alerts.deviceOffline).not.toHaveBeenCalled();

    await service.checkAllDevices(); // éxito
    expect(await redis.get('health:fail:h1')).toBeNull();

    reachability.check.mockResolvedValueOnce(false);
    await service.checkAllDevices(); // fallo de nuevo: vuelve a contar desde 1
    expect(await redis.get('health:fail:h1')).toBe('1');
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('dos fallos seguidos → offline, health:down con el inicio y una sola alerta; los siguientes fallos no envían nada', async () => {
    const { service, prisma, realtime, redis, alerts } = setup([hioki()], { reachable: false });
    await service.checkAllDevices();
    await service.checkAllDevices();

    expect(prisma.device.update).toHaveBeenCalledTimes(1);
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 'h1' }, data: { status: 'offline' } });
    expect(realtime.deviceStatus).toHaveBeenCalledWith('h1', 'p1', 'offline');
    const downIso = await redis.get('health:down:h1');
    expect(downIso).not.toBeNull();
    expect(alerts.deviceOffline).toHaveBeenCalledTimes(1);
    expect(alerts.deviceOffline).toHaveBeenCalledWith({ id: 'h1', name: 'Hioki 1', projectId: 'p1' }, new Date(downIso!));

    await service.checkAllDevices();
    await service.checkAllDevices();
    expect(prisma.device.update).toHaveBeenCalledTimes(1);
    expect(alerts.deviceOffline).toHaveBeenCalledTimes(1);
    expect(alerts.deviceOnline).not.toHaveBeenCalled();
  });

  it('recuperación → online con un solo éxito, un aviso con el inicio de la caída y borra las claves', async () => {
    const { service, prisma, reachability, redis, alerts } = setup([hioki()], { reachable: false });
    await service.checkAllDevices();
    await service.checkAllDevices();
    const downAt = new Date(Date.now() - 12 * 60_000);
    await redis.set('health:down:h1', downAt.toISOString());

    reachability.check.mockResolvedValue(true);
    await service.checkAllDevices();
    expect(prisma.device.update).toHaveBeenLastCalledWith({ where: { id: 'h1' }, data: { status: 'online' } });
    await service.checkAllDevices();

    expect(prisma.device.update).toHaveBeenCalledTimes(2);
    expect(alerts.deviceOnline).toHaveBeenCalledTimes(1);
    const [device, from, to] = alerts.deviceOnline.mock.calls[0] as any[];
    expect(device).toEqual({ id: 'h1', name: 'Hioki 1', projectId: 'p1' });
    expect(from).toEqual(downAt);
    expect(to.getTime()).toBeGreaterThanOrEqual(downAt.getTime());
    expect(await redis.get('health:down:h1')).toBeNull();
    expect(await redis.get('health:fail:h1')).toBeNull();
  });

  it('sin caída registrada (p. ej. dispositivo nuevo, offline por defecto) pasar a online no avisa', async () => {
    const { service, prisma, alerts } = setup([{ ...hioki(), status: 'offline' }]);
    await service.checkAllDevices();
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 'h1' }, data: { status: 'online' } });
    expect(alerts.deviceOnline).not.toHaveBeenCalled();
  });

  it('un dispositivo sin chequear (unchecked) que falla pasa a offline sin alerta (nunca estuvo online)', async () => {
    const { service, prisma, alerts } = setup([{ ...hioki(), status: 'unchecked' }], { reachable: false });
    await service.checkAllDevices();
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 'h1' }, data: { status: 'offline' } });
    expect(alerts.deviceOffline).not.toHaveBeenCalled();
  });

  it('health:down (TTL 30 días) se escribe antes de pasar la BD a offline', async () => {
    const { service, prisma, redis } = setup([hioki()], { reachable: false });
    let downAtUpdate: string | null = 'unset';
    prisma.device.update.mockImplementationOnce(async () => {
      downAtUpdate = await redis.get('health:down:h1');
      return {};
    });
    await service.checkAllDevices();
    await service.checkAllDevices();
    expect(prisma.device.update).toHaveBeenCalledTimes(1);
    expect(downAtUpdate).not.toBeNull();
    expect(downAtUpdate).not.toBe('unset');
    const ttl = await redis.ttl('health:down:h1');
    expect(ttl).toBeGreaterThan(30 * 24 * 3600 - 10);
    expect(ttl).toBeLessThanOrEqual(30 * 24 * 3600);
    expect(await redis.ttl('health:fail:h1')).toBeGreaterThan(0); // incr + expire juntos
  });

  it('si Redis falla al marcar la caída, el dispositivo sigue online (sin aviso) y se reintenta después', async () => {
    const { service, prisma, redis, alerts } = setup([hioki()], { reachable: false });
    const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    await service.checkAllDevices();
    jest.spyOn(redis, 'set').mockRejectedValueOnce(new Error('redis down') as never);
    await service.checkAllDevices();
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(alerts.deviceOffline).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    await service.checkAllDevices(); // Redis vuelve: ahora sí
    expect(prisma.device.update).toHaveBeenCalledWith({ where: { id: 'h1' }, data: { status: 'offline' } });
    expect(alerts.deviceOffline).toHaveBeenCalledTimes(1);
  });

  it('un error de Redis en un dispositivo no corta el chequeo de los demás (se mantiene su estado)', async () => {
    const devices = [
      { ...hioki(), status: 'offline' },
      { ...hioki(), id: 'h2', name: 'Hioki 2', status: 'offline' },
    ];
    const { service, prisma, redis } = setup(devices);
    const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(redis, 'del').mockRejectedValueOnce(new Error('redis down') as never);

    await expect(service.checkAllDevices()).resolves.toBeUndefined();

    expect(prisma.device.update).toHaveBeenCalledTimes(1); // el otro sí pasa a online
    expect(devices.filter((d) => d.status === 'offline')).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('si falla el MULTI del contador, el dispositivo mantiene su estado y el resto sigue', async () => {
    const devices = [hioki(), { ...hioki(), id: 'h2', name: 'Hioki 2' }];
    const { service, prisma, redis } = setup(devices, { reachable: false });
    const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    await service.checkAllDevices();
    const realMulti = redis.multi.bind(redis);
    jest.spyOn(redis, 'multi').mockImplementationOnce(() => {
      const m = realMulti();
      m.exec = async () => [[new Error('redis down'), null]] as any;
      return m;
    });
    await service.checkAllDevices();
    expect(prisma.device.update).toHaveBeenCalledTimes(1); // solo el que pudo contar su 2.º fallo
    expect(devices.filter((d) => d.status === 'online')).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('un fallo al alertar no rompe el ciclo: se registra y el resto de dispositivos se chequea', async () => {
    const devices = [hioki(), { ...hioki(), id: 'h2', name: 'Hioki 2' }];
    const { service, prisma, alerts } = setup(devices, { reachable: false });
    alerts.deviceOffline.mockRejectedValue(new Error('db down'));
    const errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    await service.checkAllDevices();
    await service.checkAllDevices();
    expect(prisma.device.update).toHaveBeenCalledTimes(2);
    expect(alerts.deviceOffline).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

describe('DeviceAlerts', () => {
  const device = { id: 'h1', name: 'Hioki 1', projectId: 'p1' };

  function setupAlerts() {
    const prisma = {
      teamMember: {
        findMany: jest.fn(async () => [
          { teamId: 't1', userId: 'u1', role: 'ADMIN', user: { email: 'admin1@x.pe' } },
          { teamId: 't1', userId: 'u2', role: 'MEMBER', user: { email: 'm2@x.pe' } },
          { teamId: 't2', userId: 'u3', role: 'ADMIN', user: { email: 'admin3@x.pe' } },
          { teamId: 't2', userId: 'u1', role: 'ADMIN', user: { email: 'admin1@x.pe' } }, // en dos equipos
        ]),
      },
    };
    const teamScope = { teamIdsForProject: jest.fn(async () => ['t1', 't2']) };
    const writer = { notifyDeviceOffline: jest.fn(async () => undefined), notifyDeviceOnline: jest.fn(async () => undefined) };
    const outbox = { enqueue: jest.fn(async () => undefined) };
    const reservations = { upcomingForDevice: jest.fn(async () => 3), missedOfflineForDevice: jest.fn(async () => 2) };
    const alerts = new DeviceAlerts(prisma as any, teamScope as any, writer as any, outbox as any, reservations as any);
    return { alerts, prisma, teamScope, writer, outbox, reservations };
  }

  it('desconexión: campana por miembro APPROVED de los equipos del proyecto y un correo por ADMIN', async () => {
    const { alerts, prisma, teamScope, writer, outbox, reservations } = setupAlerts();
    const at = new Date('2026-11-27T19:05:00.000Z'); // 14:05 en Lima (UTC−5)

    await alerts.deviceOffline(device, at);

    expect(teamScope.teamIdsForProject).toHaveBeenCalledWith('p1');
    expect(prisma.teamMember.findMany).toHaveBeenCalledWith({
      where: { teamId: { in: ['t1', 't2'] }, status: 'APPROVED' },
      select: { teamId: true, userId: true, role: true, user: { select: { email: true } } },
    });
    expect(reservations.upcomingForDevice).toHaveBeenCalledWith('h1', 'p1', at, 60);
    // un evento por equipo; cada usuario recibe una sola campana aunque esté en dos equipos
    expect(writer.notifyDeviceOffline).toHaveBeenCalledTimes(2);
    expect(writer.notifyDeviceOffline).toHaveBeenCalledWith('t1', ['u1', 'u2'], { id: 'h1', name: 'Hioki 1' }, 3, '14:05');
    expect(writer.notifyDeviceOffline).toHaveBeenCalledWith('t2', ['u3'], { id: 'h1', name: 'Hioki 1' }, 3, '14:05');
    // un correo por ADMIN (sin duplicar al que está en dos equipos)
    expect(outbox.enqueue).toHaveBeenCalledTimes(2);
    expect(outbox.enqueue).toHaveBeenCalledWith({
      to: 'admin1@x.pe',
      subject: 'KRONOS: Hioki 1 desconectado',
      text: 'Hioki 1 se desconectó a las 14:05. 3 mediciones programadas en la próxima hora.',
    });
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({ to: 'admin3@x.pe' }));
  });

  it('recuperación: aviso con minutos desconectado y puntos perdidos por device_offline en la caída, sin correo', async () => {
    const { alerts, writer, outbox, reservations } = setupAlerts();
    const from = new Date('2026-11-27T19:05:00.000Z');
    const to = new Date('2026-11-27T19:17:20.000Z');

    await alerts.deviceOnline(device, from, to);

    expect(reservations.missedOfflineForDevice).toHaveBeenCalledWith('h1', 'p1', from, to);
    expect(writer.notifyDeviceOnline).toHaveBeenCalledWith('t1', ['u1', 'u2'], { id: 'h1', name: 'Hioki 1' }, 12, 2);
    expect(writer.notifyDeviceOnline).toHaveBeenCalledWith('t2', ['u3'], { id: 'h1', name: 'Hioki 1' }, 12, 2);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('un fallo en un equipo o un correo no impide los demás (se registra)', async () => {
    const { alerts, writer, outbox } = setupAlerts();
    writer.notifyDeviceOffline.mockRejectedValueOnce(new Error('db'));
    outbox.enqueue.mockRejectedValueOnce(new Error('redis'));
    const errorSpy = jest.spyOn((alerts as any).logger, 'error').mockImplementation(() => undefined);

    await alerts.deviceOffline(device, new Date());

    expect(writer.notifyDeviceOffline).toHaveBeenCalledTimes(2);
    expect(outbox.enqueue).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('si no se pueden contar las mediciones en riesgo, el aviso sale igual con N = 0', async () => {
    const { alerts, writer, outbox, reservations } = setupAlerts();
    reservations.upcomingForDevice.mockRejectedValueOnce(new Error('db'));
    const errorSpy = jest.spyOn((alerts as any).logger, 'error').mockImplementation(() => undefined);
    const at = new Date('2026-11-27T19:05:00.000Z');

    await alerts.deviceOffline(device, at);

    expect(writer.notifyDeviceOffline).toHaveBeenCalledWith('t1', ['u1', 'u2'], { id: 'h1', name: 'Hioki 1' }, 0, '14:05');
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hioki 1 se desconectó a las 14:05. 0 mediciones programadas en la próxima hora.' }),
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('sin equipos relacionados no consulta miembros ni notifica', async () => {
    const { alerts, prisma, teamScope, writer, outbox } = setupAlerts();
    teamScope.teamIdsForProject.mockResolvedValue([]);
    await alerts.deviceOffline(device, new Date());
    expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
    expect(writer.notifyDeviceOffline).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
