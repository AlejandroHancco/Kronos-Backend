import { HiokiIm3570Plugin } from './hioki-im3570.plugin';
import { effectiveConfiguration } from '../../core/configuration';

describe('HiokiIm3570Plugin', () => {
  const plugin = new HiokiIm3570Plugin();
  const d = plugin.describe();

  it('se describe como sensor hioki-im3570 sin actuators, con g y b en S', () => {
    expect(HiokiIm3570Plugin.DEVICE_TYPE).toBe('hioki-im3570');
    expect(d).toMatchObject({
      deviceType: 'hioki-im3570', shortName: 'Hioki IM3570', actuators: [], connection: { requiresIp: true, defaultPort: 3570 },
    });
    expect(d.channelSelector).toBeUndefined();
    expect(d.sensors[0].sensorValues.map((v) => [v.name, v.unit])).toEqual([['g', 'S'], ['b', 'S']]);
  });

  it('declara 6 parámetros de configuración', () => {
    expect(d.configuration.map((p) => p.name)).toEqual([
      'mode', 'parameters', 'defaultStartFreq', 'defaultStopFreq', 'defaultPoints', 'defaultSweepType',
    ]);
  });

  it('los valores por defecto de la configuración caen dentro de lo declarado en acquisition', () => {
    const acquisition = d.sensors[0].acquisition;
    if (acquisition.kind !== 'sweep') throw new Error('se esperaba un sensor sweep');
    const byName = Object.fromEntries(d.configuration.map((p) => [p.name, p]));
    expect(byName.defaultStartFreq.rangeMinimum).toBeGreaterThanOrEqual(acquisition.variable.rangeMinimum);
    expect(byName.defaultStartFreq.rangeMaximum).toBeLessThanOrEqual(acquisition.variable.rangeMaximum);
    expect(byName.defaultStopFreq.rangeMinimum).toBeGreaterThanOrEqual(acquisition.variable.rangeMinimum);
    expect(byName.defaultStopFreq.rangeMaximum).toBeLessThanOrEqual(acquisition.variable.rangeMaximum);
    expect(byName.defaultPoints.rangeMinimum).toBeGreaterThanOrEqual(acquisition.points.minimum);
    expect(byName.defaultPoints.rangeMaximum).toBeLessThanOrEqual(acquisition.points.maximum);
    for (const value of byName.defaultSweepType.allowedValues!) {
      expect(acquisition.scales).toContain(value);
    }
  });

  it('validateConfiguration exige frecuencia inicial < final', () => {
    const cfg = effectiveConfiguration(d.configuration, {});
    expect(plugin.validateConfiguration(cfg)).toBeNull();
    expect(plugin.validateConfiguration({ ...cfg, defaultStartFreq: 10, defaultStopFreq: 5 })).toBe(
      '"Frecuencia inicial por defecto" debe ser menor que "Frecuencia final por defecto"',
    );
  });

  it('testConnection sin IP es false sin abrir socket', async () => {
    await expect(plugin.testConnection({ ip: null })).resolves.toBe(false);
  });

  it('getSensorData sin IP falla con un mensaje claro (no intenta localhost)', async () => {
    await expect(
      plugin.getSensorData({ id: 'h', name: 'Hioki lab', ip: null, configuration: {} }, { kind: 'sweep', start: 1, stop: 2, points: 2, scale: 'LOG' }),
    ).rejects.toThrow('El equipo "Hioki lab" no tiene IP configurada');
  });

  it('getSensorData rechaza lecturas puntuales', async () => {
    await expect(
      plugin.getSensorData({ id: 'h', name: 'Hioki lab', ip: '10.0.0.5', configuration: {} }, { kind: 'single' }),
    ).rejects.toThrow('El Hioki IM3570 solo hace barridos');
  });
});
