import { DevicePluginRegistry, roleOf } from './device-plugin.registry';
import { HiokiIm3570Plugin } from '../plugins/hioki-im3570/hioki-im3570.plugin';
import { KronosMux16Plugin } from '../plugins/kronos-mux-16/kronos-mux-16.plugin';
import { SimulatedImpedancePlugin } from '../plugins/sim-impedance/sim-impedance.plugin';
import { ConfigurationParameterMetadata, DevicePlugin, DeviceServiceDescription } from './device-plugin.interface';

const build = () => new DevicePluginRegistry([new HiokiIm3570Plugin(), new KronosMux16Plugin(), new SimulatedImpedancePlugin()]);

const sensorMeta = {
  sensorId: 's', fullName: 'S', description: '', protocol: 'simulated' as const, produces: 'application/json',
  sensorValues: [{ name: 'z', unit: 'Ω', type: 'double' as const }], accessMode: { accessModeType: 'pull' as const },
};
const actuatorMeta = {
  actuatorId: 'a', fullName: 'A', description: '', protocol: 'http' as const, inputType: 'integer' as const,
  actuatorValues: [{ name: 'channel', unit: '', type: 'integer' as const, rangeMinimum: 1, rangeMaximum: 4 }],
  accessMode: { accessModeType: 'pull' as const },
};
const liveParam: ConfigurationParameterMetadata = {
  name: 'channel', label: 'Canal', type: 'integer', unit: '', access: 'read-write', storage: 'live',
};
const describeAs = (d: Partial<DeviceServiceDescription>): DeviceServiceDescription => ({
  deviceType: 'x', fullName: 'X', shortName: 'X', manufacturer: 'M', description: 'd', simulated: false,
  connection: { requiresIp: false }, sensors: [], actuators: [], configuration: [], ...d,
});
const fake = (d: Partial<DeviceServiceDescription>, methods: Record<string, unknown> = {}): DevicePlugin =>
  ({ describe: () => describeAs(d), testConnection: async () => true, ...methods }) as DevicePlugin;
const getSensorData = async () => [];
const setActuatorData = async () => undefined;

describe('DevicePluginRegistry', () => {
  it('roles por capacidad', () => {
    const r = build();
    expect([r.role('hioki-im3570'), r.role('kronos-mux-16'), r.role('sim-impedance')]).toEqual(['sensor', 'channel-selector', 'sensor']);
    expect(r.role('analyzer')).toBeUndefined();
    expect(r.channelSelector('kronos-mux-16')).toMatchObject({ actuatorId: 'kronos-mux-16-channel', valueName: 'channel', range: { min: 1, max: 16 } });
    expect(r.channelSelector('kronos-mux-16').plugin).toBe(r.get('kronos-mux-16'));
    expect(r.sensor('hioki-im3570')).toBe(r.get('hioki-im3570'));
    expect(() => r.sensor('kronos-mux-16')).toThrow(/no es un equipo de medición/);
    expect(() => r.channelSelector('hioki-im3570')).toThrow(/no es un selector de canal/);
  });

  it('catálogo v2', () => {
    const e = build().catalog();
    expect(e.find((x) => x.deviceType === 'kronos-mux-16')).toMatchObject({
      role: 'channel-selector', shortName: 'MUX Kronos 16', channelRange: { min: 1, max: 16 },
    });
    expect(e.find((x) => x.deviceType === 'hioki-im3570')).toMatchObject({
      role: 'sensor', channelRange: null, connection: { requiresIp: true, defaultPort: 3570 },
    });
    expect(e.find((x) => x.deviceType === 'sim-impedance')).toMatchObject({
      role: 'sensor', simulated: true, connection: { requiresIp: false }, label: 'Impedancímetro simulado (Randles)',
    });
    expect(e[0]).not.toHaveProperty('channelSelection');
    expect(e[0].configuration).toBe(e[0].service.configuration);
  });

  it('rechaza duplicados y plugins sin la capacidad declarada', () => {
    const r = build();
    expect(() => r.register(fake({ deviceType: 'y', sensors: [sensorMeta] }))).toThrow(/getSensorData/);
    expect(() => r.register(fake({ deviceType: 'y', actuators: [actuatorMeta], channelSelector: { actuatorId: 'a', valueName: 'channel' } })))
      .toThrow(/setActuatorData/);
    expect(() => r.register(fake({ deviceType: 'y', sensors: [sensorMeta], configuration: [liveParam] }, { getSensorData })))
      .toThrow(/live/);
    expect(() => r.register(fake(
      { deviceType: 'y', sensors: [sensorMeta], actuators: [actuatorMeta], channelSelector: { actuatorId: 'a', valueName: 'channel' } },
      { getSensorData, setActuatorData },
    ))).toThrow(/a la vez/);
    expect(() => r.register(fake({ deviceType: 'y' }))).toThrow(/ni un selector/);
    expect(() => r.register(fake({ deviceType: 'hioki-im3570', sensors: [sensorMeta] }, { getSensorData }))).toThrow(/duplicado/);
  });

  it('roleOf es puro y acepta live con read/applyLiveConfiguration', () => {
    const plugin = fake({}, {
      getSensorData, readLiveConfiguration: async () => ({}), applyLiveConfiguration: async () => undefined,
    });
    expect(roleOf(plugin, describeAs({ sensors: [sensorMeta], configuration: [liveParam] }))).toBe('sensor');
  });

  it('get() de un tipo desconocido lanza NotFound', () => {
    expect(() => build().get('nope')).toThrow(/No hay un device plugin/);
  });
});
