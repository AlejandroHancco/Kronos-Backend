import { DevicePluginRegistry } from './device-plugin.registry';
import { HiokiIm3570Plugin } from './plugins/hioki-im3570.plugin';
import { SimulatedImpedancePlugin } from './plugins/simulated-impedance.plugin';
import { DeviceDriverPlugin, DeviceServiceDescription } from './device-plugin.interface';

const fake = (d: Partial<DeviceServiceDescription>): DeviceDriverPlugin => ({
  describe: () => ({
    deviceType: 'x', fullName: 'X', manufacturer: 'M', description: 'd', simulated: false,
    connection: { requiresIp: false }, sensors: [], actuators: [], ...d,
  }),
  testConnection: async () => true,
  measureChannel: async () => [],
});

describe('DevicePluginRegistry', () => {
  const build = () => {
    const r = new DevicePluginRegistry(new HiokiIm3570Plugin(), new SimulatedImpedancePlugin());
    r.onModuleInit();
    return r;
  };

  it('registra el analyzer como sensor y su MUX como channel-selector', () => {
    const r = build();
    expect(r.role('analyzer')).toBe('sensor');
    expect(r.role('mux')).toBe('channel-selector');
    expect(r.get('mux')).toBe(r.get('analyzer'));
  });

  it('catalog() expone etiqueta, conexión y binding del selector', () => {
    const entries = build().catalog();
    const analyzer = entries.find((e) => e.deviceType === 'analyzer')!;
    expect(analyzer.channelSelection).toMatchObject({ hostDeviceType: 'mux', required: true });
    expect(analyzer.connection).toEqual({ requiresIp: true, defaultPort: 3570 });
    expect(analyzer.service.sensors[0].sensorValues.map((v) => [v.name, v.unit])).toEqual([['g', 'S'], ['b', 'S']]);
    const mux = entries.find((e) => e.deviceType === 'mux')!;
    expect(mux).toMatchObject({ role: 'channel-selector', channelSelection: null });
  });

  it('el actuator del MUX declara canal entero 1..16', () => {
    const act = build().describe('analyzer').actuators[0];
    expect(act.actuatorValues[0]).toMatchObject({ name: 'channel', type: 'integer', rangeMinimum: 1, rangeMaximum: 16, rangeStep: 1 });
    expect(act.accessMode.accessModeType).toBe('pull');
  });

  it('rechaza tipos duplicados y nombres de valor repetidos', () => {
    const r = build();
    expect(() => r.register(fake({ deviceType: 'analyzer' }))).toThrow(/duplicado/);
    const v = { name: 'z', unit: 'Ω', type: 'double' as const };
    const sensor = (id: string) => ({ sensorId: id, fullName: id, description: '', protocol: 'simulated' as const,
      produces: 'application/json', sensorValues: [v], accessMode: { accessModeType: 'pull' as const } });
    expect(() => r.register(fake({ deviceType: 'y', sensors: [sensor('a'), sensor('b')] }))).toThrow(/repetido/);
  });

  it('get() de un tipo desconocido lanza NotFound', () => {
    expect(() => build().get('nope')).toThrow(/No hay un device plugin/);
  });

  it('incluye el plugin simulado como sensor sin IP', () => {
    const sim = build().catalog().find((e) => e.deviceType === 'sim-impedance')!;
    expect(sim).toMatchObject({ role: 'sensor', simulated: true, connection: { requiresIp: false }, channelSelection: null });
  });
});
