import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { DevicePluginRegistry } from '../device-plugins/device-plugin.registry';
import { HiokiIm3570Plugin } from '../device-plugins/plugins/hioki-im3570.plugin';
import { SimulatedImpedancePlugin } from '../device-plugins/plugins/simulated-impedance.plugin';

function setup() {
  const registry = new DevicePluginRegistry(new HiokiIm3570Plugin(), new SimulatedImpedancePlugin());
  registry.onModuleInit();
  const prisma = {
    device: { create: jest.fn(async ({ data }) => data), findFirst: jest.fn() },
    measurement: { findFirst: jest.fn() },
  };
  const teamScope = { assertProjectInTeam: jest.fn(), projectWhereForUser: jest.fn(async () => ({})) };
  return { service: new DevicesService(prisma as any, teamScope as any, registry), prisma };
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
    await expect(setup().service.testConnection({ type: 'analyzer' })).rejects.toBeInstanceOf(BadRequestException);
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
});
