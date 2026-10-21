import { DevicePluginRegistry } from './device-plugin.registry';
import { HiokiIm3570Plugin } from '../plugins/hioki-im3570/hioki-im3570.plugin';
import { KronosMux16Plugin } from '../plugins/kronos-mux-16/kronos-mux-16.plugin';
import { SimulatedImpedancePlugin } from '../plugins/sim-impedance/sim-impedance.plugin';
import { ExperimentCatalogService } from './experiment-catalog.service';

const registry = new DevicePluginRegistry([new HiokiIm3570Plugin(), new KronosMux16Plugin(), new SimulatedImpedancePlugin()]);
const devices = [
  { id: 'h', name: 'Hioki lab', type: 'hioki-im3570', ip: '10.0.0.2', status: 'online' },
  { id: 'm', name: 'MUX', type: 'kronos-mux-16', ip: '10.0.0.3', status: 'offline' },
];

describe('ExperimentCatalogService', () => {
  const findMany = jest.fn(async () => devices);
  const teamScope = { assertProjectInTeam: jest.fn(async () => undefined) };
  const service = new ExperimentCatalogService({ device: { findMany } } as any, registry, teamScope as any);

  it('catalog: los cuatro experimentos derivados', () => {
    expect(service.catalog()).toHaveLength(4);
  });

  it('forProject: alcance de equipo, dispositivos no archivados y disponibilidad', async () => {
    const result = await service.forProject('P', 'U');
    expect(teamScope.assertProjectInTeam).toHaveBeenCalledWith('U', 'P');
    expect(findMany).toHaveBeenCalledWith({
      where: { projectId: 'P', status: { not: 'archived' } },
      select: { id: true, name: true, type: true, ip: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    const [hiokiMux, hioki, simMux, sim] = result;
    expect(hiokiMux).toMatchObject({
      available: true,
      sensorDevices: [{ id: 'h', name: 'Hioki lab', ip: '10.0.0.2', status: 'online' }],
      channelSelectorDevices: [{ id: 'm', name: 'MUX', ip: '10.0.0.3', status: 'offline' }],
    });
    expect(hiokiMux.sensorDevices[0]).not.toHaveProperty('type');
    expect(hioki).toMatchObject({ available: true, channelSelectorDevices: [] });
    expect(hioki.unavailableReason).toBeUndefined();
    for (const e of [simMux, sim]) {
      expect(e).toMatchObject({ available: false, unavailableReason: 'No hay un dispositivo "Simulador (Randles)" en el proyecto' });
    }
  });

  it('sin selector en el proyecto: la combinación con MUX no está disponible', async () => {
    findMany.mockResolvedValueOnce([devices[0]]);
    const [hiokiMux] = await service.forProject('P', 'U');
    expect(hiokiMux).toMatchObject({ available: false, unavailableReason: 'No hay un dispositivo "MUX Kronos 16" en el proyecto' });
  });
});
