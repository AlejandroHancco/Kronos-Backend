import { LaasCatalog, roleOf } from './laas-catalog';
import { DEVICE_MODELS, HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE, AGILENT_E4402B } from './models';
import { effectiveConfiguration } from './configuration';
import type { DeviceModelDefinition, DeviceServiceDescription } from './contract';

const build = () => new LaasCatalog([HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE]);

const sensorMeta = {
  sensorId: 's', fullName: 'S', description: '', protocol: 'simulated' as const, produces: 'application/json',
  sensorValues: [{ name: 'z', unit: 'Ω', type: 'double' as const }], accessMode: { accessModeType: 'pull' as const },
  acquisition: { kind: 'single' as const, secondsPerReading: 1 },
};
const actuatorMeta = {
  actuatorId: 'a', fullName: 'A', description: '', protocol: 'http' as const, inputType: 'integer' as const,
  actuatorValues: [{ name: 'channel', unit: '', type: 'integer' as const, rangeMinimum: 1, rangeMaximum: 4 }],
  accessMode: { accessModeType: 'pull' as const },
};
const describeAs = (d: Partial<DeviceServiceDescription>): DeviceServiceDescription => ({
  deviceType: 'x', fullName: 'X', shortName: 'X', manufacturer: 'M', description: 'd', simulated: false,
  connection: { requiresIp: false }, sensors: [], actuators: [], configuration: [], ...d,
});
const model = (d: Partial<DeviceServiceDescription>): DeviceModelDefinition => ({ description: describeAs(d) });

describe('LaasCatalog', () => {
  it('roles desde la descripción (sin código de E/S)', () => {
    const c = build();
    expect([c.role('hioki-im3570'), c.role('kronos-mux-16'), c.role('sim-impedance')]).toEqual(['sensor', 'channel-selector', 'sensor']);
    expect(c.role('analyzer')).toBeUndefined();
    expect(c.role(null)).toBeUndefined();
    expect(c.has('hioki-im3570')).toBe(true);
    expect(c.has('analyzer')).toBe(false);
    expect(c.has(undefined)).toBe(false);
  });

  it('channelSelector: actuator, valor y rango declarados; los sensores no lo son', () => {
    const c = build();
    expect(c.channelSelector('kronos-mux-16')).toEqual({ actuatorId: 'kronos-mux-16-channel', valueName: 'channel', range: { min: 1, max: 16 } });
    expect(() => c.channelSelector('hioki-im3570')).toThrow(/no es un selector de canal/);
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

  it('DEVICE_MODELS: los 6 modelos', () => {
    expect(new LaasCatalog(DEVICE_MODELS).catalog().map((e) => e.deviceType).sort()).toEqual([
      'agilent-e4402b', 'hioki-im3570', 'kronos-mux-16', 'sim-impedance', 'sim-spectrum', 'sim-temperature',
    ]);
  });

  it('rechaza al construir: duplicados, sensor y selector a la vez, ni sensor ni selector', () => {
    expect(() => new LaasCatalog([HIOKI_IM3570, model({ deviceType: 'hioki-im3570', sensors: [sensorMeta] })])).toThrow(
      'Tipo de dispositivo duplicado: "hioki-im3570"',
    );
    expect(() => new LaasCatalog([model({
      deviceType: 'y', sensors: [sensorMeta], actuators: [actuatorMeta], channelSelector: { actuatorId: 'a', valueName: 'channel' },
    })])).toThrow('Plugin "y": no puede ser sensor y selector de canal a la vez');
    expect(() => new LaasCatalog([model({ deviceType: 'y' })])).toThrow('Plugin "y": no declara sensores ni un selector de canal');
  });

  it('roleOf es puro y solo mira la descripción', () => {
    expect(roleOf(describeAs({ sensors: [sensorMeta] }))).toBe('sensor');
    expect(roleOf(describeAs({ actuators: [actuatorMeta], channelSelector: { actuatorId: 'a', valueName: 'channel' } }))).toBe('channel-selector');
  });

  it('describe / validateConfiguration de un tipo desconocido lanza NotFound', () => {
    expect(() => build().describe('nope')).toThrow('No hay un device plugin registrado para el tipo "nope"');
    expect(() => build().validateConfiguration('nope', {})).toThrow(/No hay un device plugin/);
  });

  it('validateConfiguration: reglas del modelo; null si no declara reglas', () => {
    const c = new LaasCatalog([HIOKI_IM3570, AGILENT_E4402B, SIM_IMPEDANCE]);
    const hioki = effectiveConfiguration(HIOKI_IM3570.description.configuration, {});
    expect(c.validateConfiguration('hioki-im3570', hioki)).toBeNull();
    expect(c.validateConfiguration('hioki-im3570', { ...hioki, defaultStartFreq: 10, defaultStopFreq: 5 })).toBe(
      '"Frecuencia inicial por defecto" debe ser menor que "Frecuencia final por defecto"',
    );
    const agilent = effectiveConfiguration(AGILENT_E4402B.description.configuration, {});
    expect(c.validateConfiguration('agilent-e4402b', { ...agilent, resolutionBandwidth: '500' })).toMatch(/RBW/);
    expect(c.validateConfiguration('sim-impedance', { rp: 1 })).toBeNull();
  });
});
