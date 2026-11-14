import { DEVICE_MODELS, LaasCatalog, type DeviceModelDefinition, type DeviceServiceDescription } from '@app/laas-catalog';
import { DeviceDriverRegistry } from './device-driver.registry';
import type { DeviceDriver } from './device-driver';
import { HiokiIm3570Driver } from './drivers/hioki-im3570/hioki-im3570.driver';
import { KronosMux16Driver } from './drivers/kronos-mux-16/kronos-mux-16.driver';
import { SimulatedImpedanceDriver } from './drivers/sim-impedance/sim-impedance.driver';
import { DEVICE_DRIVERS } from './drivers';

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
const model = (d: Partial<DeviceServiceDescription>): DeviceModelDefinition => ({
  description: {
    deviceType: 'x', fullName: 'X', shortName: 'X', manufacturer: 'M', description: 'd', simulated: false,
    connection: { requiresIp: false }, sensors: [], actuators: [], configuration: [], ...d,
  },
});
const sensorModel = (deviceType: string, live = false) => model({
  deviceType, sensors: [sensorMeta],
  configuration: live ? [{ name: 'gain', label: 'Ganancia', type: 'integer', unit: '', access: 'read-write', storage: 'live' }] : [],
});
const selectorModel = (deviceType: string) =>
  model({ deviceType, actuators: [actuatorMeta], channelSelector: { actuatorId: 'a', valueName: 'channel' } });
const driver = (deviceType: string, methods: Partial<DeviceDriver> = {}): DeviceDriver =>
  ({ deviceType, testConnection: async () => true, ...methods });
const getSensorData = async () => [];
const setActuatorData = async () => undefined;

const build = () => new DeviceDriverRegistry([new HiokiIm3570Driver(), new KronosMux16Driver(), new SimulatedImpedanceDriver()]);

describe('DeviceDriverRegistry', () => {
  it('get / sensor / actuator por tipo', () => {
    const r = build();
    expect(r.has('hioki-im3570')).toBe(true);
    expect(r.has('nope')).toBe(false);
    expect(r.sensor('hioki-im3570')).toBe(r.get('hioki-im3570'));
    expect(r.actuator('kronos-mux-16')).toBe(r.get('kronos-mux-16'));
    expect(() => r.sensor('kronos-mux-16')).toThrow(/no es un equipo de medición/);
    expect(() => r.actuator('hioki-im3570')).toThrow(/no es un selector de canal/);
    expect(() => r.get('nope')).toThrow(/No hay un device plugin registrado para el tipo "nope"/);
  });

  it('rechaza drivers duplicados', () => {
    expect(() => new DeviceDriverRegistry([driver('y'), driver('y')])).toThrow('Tipo de dispositivo duplicado: "y"');
  });

  it('DEVICE_DRIVERS y DEVICE_MODELS están en paridad', () => {
    const drivers = new DeviceDriverRegistry(DEVICE_DRIVERS.map((D) => new D()));
    expect(() => drivers.assertParity(new LaasCatalog(DEVICE_MODELS))).not.toThrow();
  });

  describe('assertParity', () => {
    const parity = (models: DeviceModelDefinition[], drivers: DeviceDriver[]) => () =>
      new DeviceDriverRegistry(drivers).assertParity(new LaasCatalog(models));

    it('acepta sensor con getSensorData, selector con setActuatorData y live con applyLiveConfiguration', () => {
      expect(parity(
        [sensorModel('s1', true), selectorModel('m1')],
        [driver('s1', { getSensorData, applyLiveConfiguration: async () => undefined }), driver('m1', { setActuatorData })],
      )).not.toThrow();
    });

    it('descripción sin driver', () => {
      expect(parity([sensorModel('s1'), sensorModel('s2')], [driver('s1', { getSensorData })])).toThrow(/"s2".*sin driver/);
    });

    it('driver sin descripción', () => {
      expect(parity([sensorModel('s1')], [driver('s1', { getSensorData }), driver('ghost', { getSensorData })]))
        .toThrow(/"ghost".*sin descripción/);
    });

    it('sensor sin getSensorData', () => {
      expect(parity([sensorModel('s1')], [driver('s1')])).toThrow('Plugin "s1": declara sensores pero no implementa getSensorData');
    });

    it('selector sin setActuatorData', () => {
      expect(parity([selectorModel('m1')], [driver('m1')])).toThrow('Plugin "m1": declara channelSelector pero no implementa setActuatorData');
    });

    it('parámetros live sin applyLiveConfiguration (readLiveConfiguration es opcional)', () => {
      expect(parity([sensorModel('s1', true)], [driver('s1', { getSensorData, readLiveConfiguration: async () => ({}) })]))
        .toThrow(/"s1": declara parámetros live pero no implementa applyLiveConfiguration/);
    });

    it('informa todos los modelos con problemas a la vez', () => {
      expect(parity([sensorModel('s1'), selectorModel('m1')], [driver('m1'), driver('ghost')]))
        .toThrow(/"s1".*sin driver[\s\S]*"m1".*setActuatorData[\s\S]*"ghost".*sin descripción/);
    });
  });
});
