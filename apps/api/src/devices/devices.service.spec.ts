import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DevicesService } from './devices.service';
import { HIOKI_IM3570, KRONOS_MUX_16, LaasCatalog, SIM_IMPEDANCE } from '@app/laas-catalog';
import { DeviceOpTimeoutError } from '@app/queue';

const newCatalog = () => new LaasCatalog([HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE]);

function setup() {
  const catalog = newCatalog();
  const prisma = {
    device: {
      create: jest.fn(async ({ data }) => data),
      findFirst: jest.fn(),
      findUnique: jest.fn(async () => ({ id: 'd1', projectId: 'p1', name: 'Eq', type: 'hioki-im3570', ip: '10.0.0.5' })),
      update: jest.fn(async ({ data }) => data),
    },
    taskPreference: { count: jest.fn(async () => 0) },
    measurement: { findFirst: jest.fn() },
  };
  const teamScope = { assertProjectInTeam: jest.fn(), projectWhereForUser: jest.fn(async () => ({})) };
  const deviceConfiguration = { view: jest.fn(async (d) => ({ deviceId: d.id })), apply: jest.fn(async (d) => ({ deviceId: d.id })) };
  const deviceOps = { request: jest.fn(async (..._args: any[]): Promise<any> => true) };
  return {
    service: new DevicesService(prisma as any, teamScope as any, catalog, deviceConfiguration as any, deviceOps as any),
    prisma, deviceConfiguration, deviceOps,
  };
}

describe('DevicesService (tipos por plugin)', () => {
  it('crea un dispositivo simulado sin IP aunque se envíe una', async () => {
    const { service } = setup();
    const created = await service.createInProject('p1', { name: 'Sim', type: 'sim-impedance', ip: '10.0.0.9' }, 'u1');
    expect(created).toMatchObject({ type: 'sim-impedance', ip: null, projectId: 'p1' });
  });

  it('rechaza tipos sin plugin', async () => {
    const { service } = setup();
    await expect(service.createInProject('p1', { name: 'X', type: 'osciloscopio' }, 'u1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('testConnection del simulado no exige IP', async () => {
    await expect(setup().service.testConnection({ type: 'sim-impedance' })).resolves.toEqual({
      success: true, message: 'Impedancímetro simulado (Randles) disponible (simulado)',
    });
  });

  it('testConnection del analyzer exige IP', async () => {
    await expect(setup().service.testConnection({ type: 'hioki-im3570' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('testConnection encola test-connection con DEVICE_TEST_TIMEOUT_MS y conserva los mensajes', async () => {
    const { service, deviceOps } = setup();
    await expect(service.testConnection({ type: 'hioki-im3570', ip: '10.0.0.5' })).resolves.toEqual({
      success: true, message: 'Hioki IM3570 LCR Meter encontrado en 10.0.0.5:3570',
    });
    expect(deviceOps.request).toHaveBeenCalledWith('test-connection', { type: 'hioki-im3570', ip: '10.0.0.5', port: 3570 }, 5000);
    deviceOps.request.mockResolvedValue(false);
    await expect(service.testConnection({ type: 'hioki-im3570', ip: '10.0.0.5', port: 3571 })).resolves.toEqual({
      success: false, message: 'No se pudo conectar a Hioki IM3570 LCR Meter en 10.0.0.5:3571',
    });
    expect(deviceOps.request).toHaveBeenLastCalledWith('test-connection', { type: 'hioki-im3570', ip: '10.0.0.5', port: 3571 }, 5000);
  });

  it('testConnection: timeout configurable y worker sin respuesta → no alcanzable', async () => {
    const { service, deviceOps } = setup();
    deviceOps.request.mockRejectedValue(new DeviceOpTimeoutError('timeout'));
    process.env.DEVICE_TEST_TIMEOUT_MS = '1200';
    try {
      const res = await service.testConnection({ type: 'hioki-im3570', ip: '10.0.0.5' });
      expect(res.success).toBe(false);
      expect(deviceOps.request.mock.calls[0][2]).toBe(1200);
    } finally {
      delete process.env.DEVICE_TEST_TIMEOUT_MS;
    }
  });

  it('describeForUser: 404 fuera del equipo; sensor con lastMeasured', async () => {
    const { service, prisma } = setup();
    prisma.device.findFirst.mockResolvedValueOnce(null);
    await expect(service.describeForUser('d1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    prisma.device.findFirst.mockResolvedValueOnce({ id: 'd2', name: 'Sim', type: 'sim-impedance', ip: null, status: 'online', projectId: 'p1' });
    prisma.measurement.findFirst.mockResolvedValueOnce({ takenAt: new Date('2026-10-20T10:00:00Z') });
    const out = await service.describeForUser('d2', 'u1');
    expect(prisma.measurement.findFirst.mock.calls[0][0].where).toEqual({ sensorDeviceId: 'd2' });
    expect(out.role).toBe('sensor');
    expect(out.service.sensors[0].sensorValues[0].lastMeasured).toBe('2026-10-20T10:00:00.000Z');
  });

  it('configuración: 404 fuera del equipo; dentro, delega en DeviceConfigurationService', async () => {
    const { service, prisma, deviceConfiguration } = setup();
    prisma.device.findFirst.mockResolvedValueOnce(null);
    await expect(service.configurationForUser('d1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    prisma.device.findFirst.mockResolvedValueOnce(null);
    await expect(service.configureForUser('d1', { rp: 1 }, 'u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(deviceConfiguration.view).not.toHaveBeenCalled();
    expect(deviceConfiguration.apply).not.toHaveBeenCalled();
    const row = { id: 'd2', type: 'sim-impedance' };
    prisma.device.findFirst.mockResolvedValueOnce(row);
    await service.configureForUser('d2', { rp: 1 }, 'u1');
    expect(deviceConfiguration.apply).toHaveBeenCalledWith(row, { rp: 1 });
    expect(prisma.device.findFirst).toHaveBeenLastCalledWith({ where: { id: 'd2', project: {} } });
  });

  describe('updateInProject (tipo bloqueado si está en uso)', () => {
    it('rechaza cambiar el tipo si alguna configuración de tarea usa el dispositivo', async () => {
      const { service, prisma } = setup();
      prisma.taskPreference.count.mockResolvedValueOnce(2);
      await expect(service.updateInProject('p1', 'd1', { type: 'sim-impedance' }, 'u1'))
        .rejects.toThrow(/en uso en configuraciones de tareas/);
      expect(prisma.taskPreference.count).toHaveBeenCalledWith({
        where: { OR: [{ sensorDeviceId: 'd1' }, { channelSelectorDeviceId: 'd1' }] },
      });
      expect(prisma.device.update).not.toHaveBeenCalled();
    });

    it('al cambiar a un tipo sin dirección (no en uso) deja la IP en null', async () => {
      const { service, prisma } = setup();
      const out = await service.updateInProject('p1', 'd1', { type: 'sim-impedance', ip: '10.0.0.9' }, 'u1');
      expect(out).toMatchObject({ type: 'sim-impedance', ip: null, configuration: Prisma.DbNull });
      expect(prisma.device.update).toHaveBeenCalled();
    });

    it('mismo tipo o sin tipo: no consulta uso y conserva la IP enviada', async () => {
      const { service, prisma } = setup();
      const out = await service.updateInProject('p1', 'd1', { type: 'hioki-im3570', name: 'Nuevo', ip: '10.0.0.7' }, 'u1');
      expect(out).toMatchObject({ name: 'Nuevo', ip: '10.0.0.7' });
      expect(out).not.toHaveProperty('configuration');
      await service.updateInProject('p1', 'd1', { name: 'Otro' }, 'u1');
      expect(prisma.taskPreference.count).not.toHaveBeenCalled();
    });

    it('rechaza un tipo desconocido', async () => {
      const { service } = setup();
      await expect(service.updateInProject('p1', 'd1', { type: 'osciloscopio' }, 'u1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
