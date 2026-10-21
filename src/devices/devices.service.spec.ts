import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DevicesService } from './devices.service';
import { DevicePluginRegistry } from '../device-plugins/core/device-plugin.registry';
import { HiokiIm3570Plugin } from '../device-plugins/plugins/hioki-im3570/hioki-im3570.plugin';
import { KronosMux16Plugin } from '../device-plugins/plugins/kronos-mux-16/kronos-mux-16.plugin';
import { SimulatedImpedancePlugin } from '../device-plugins/plugins/sim-impedance/sim-impedance.plugin';

function setup() {
  const registry = new DevicePluginRegistry([new HiokiIm3570Plugin(), new KronosMux16Plugin(), new SimulatedImpedancePlugin()]);
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
  return {
    service: new DevicesService(prisma as any, teamScope as any, registry, deviceConfiguration as any),
    prisma, deviceConfiguration,
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

  it('checkReachable delega en testConnection del plugin con { ip, port } (puerto por defecto del catálogo)', async () => {
    const registry = new DevicePluginRegistry([new HiokiIm3570Plugin(), new KronosMux16Plugin(), new SimulatedImpedancePlugin()]);
    const service = new DevicesService({} as any, {} as any, registry, {} as any);
    const hioki = jest.spyOn(registry.get('hioki-im3570'), 'testConnection').mockResolvedValue(true);
    const mux = jest.spyOn(registry.get('kronos-mux-16'), 'testConnection').mockResolvedValue(true);
    await expect(service.checkReachable('hioki-im3570', '10.0.0.5')).resolves.toBe(true);
    expect(hioki).toHaveBeenCalledWith({ ip: '10.0.0.5', port: 3570 });
    await expect(service.checkReachable('kronos-mux-16', '10.0.0.6', 8080)).resolves.toBe(true);
    expect(mux).toHaveBeenCalledWith({ ip: '10.0.0.6', port: 8080 });
    await expect(service.checkReachable('kronos-mux-16', null)).resolves.toBe(false);
    await expect(service.checkReachable('analyzer', '10.0.0.5')).resolves.toBe(false);
    await expect(service.checkReachable('', '10.0.0.5')).resolves.toBe(false);
  });

  it('addresslessTypes lista solo tipos sin IP', () => {
    expect(setup().service.addresslessTypes()).toEqual(['sim-impedance']);
  });

  it('describeForUser: 404 fuera del equipo; sensor con lastMeasured', async () => {
    const { service, prisma } = setup();
    prisma.device.findFirst.mockResolvedValueOnce(null);
    await expect(service.describeForUser('d1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    prisma.device.findFirst.mockResolvedValueOnce({ id: 'd2', name: 'Sim', type: 'sim-impedance', ip: null, status: 'online', projectId: 'p1' });
    prisma.measurement.findFirst.mockResolvedValueOnce({ takenAt: new Date('2026-10-20T10:00:00Z') });
    const out = await service.describeForUser('d2', 'u1');
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
        where: { OR: [{ analyzerDeviceId: 'd1' }, { muxDeviceId: 'd1' }] },
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
