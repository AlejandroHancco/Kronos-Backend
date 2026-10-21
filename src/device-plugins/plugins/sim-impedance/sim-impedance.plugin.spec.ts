import { SimulatedImpedancePlugin, randlesImpedance, sweepFrequencies, CONCRETE_LIKE } from './sim-impedance.plugin';

describe('randlesImpedance', () => {
  it('≈ Rs+Rp a baja frecuencia y ≈ Rs a muy alta frecuencia', () => {
    expect(randlesImpedance(0.01)).toBeCloseTo(CONCRETE_LIKE.rs + CONCRETE_LIKE.rp, -1);
    expect(randlesImpedance(1e9)).toBeLessThan(CONCRETE_LIKE.rs * 1.01);
  });
  it('decrece monótonamente con la frecuencia', () => {
    const z = sweepFrequencies(10, 5e6, 50, 'LOG').map((f) => randlesImpedance(f));
    for (let i = 1; i < z.length; i++) expect(z[i]).toBeLessThan(z[i - 1]);
  });
});

describe('sweepFrequencies', () => {
  it('LOG y LIN incluyen extremos y respetan points', () => {
    const log = sweepFrequencies(100, 1e6, 5, 'LOG');
    expect(log).toHaveLength(5);
    expect(log[0]).toBeCloseTo(100);
    expect(log[4]).toBeCloseTo(1e6);
    expect(log[2]).toBeCloseTo(1e4);
    expect(sweepFrequencies(0, 100, 3, 'LIN')).toEqual([0, 50, 100]);
    expect(sweepFrequencies(1000, 2000, 1, 'LIN')).toEqual([1000]);
  });
});

describe('SimulatedImpedancePlugin', () => {
  const plugin = new SimulatedImpedancePlugin();
  plugin.noise = () => 0;

  it('se describe como simulado, sin IP, sin actuators ni MUX, con z en Ω', () => {
    const d = plugin.describe();
    expect(d).toMatchObject({ deviceType: 'sim-impedance', simulated: true, connection: { requiresIp: false }, actuators: [] });
    expect(d.channelSelection).toBeUndefined();
    expect(d.description).toMatch(/SIMULADO/);
    expect(d.sensors[0].sensorValues).toEqual([
      expect.objectContaining({ name: 'z', unit: 'Ω', type: 'double', rangeMinimum: 0 }),
    ]);
  });

  it('testConnection siempre true', async () => {
    await expect(plugin.testConnection('', 'sim-impedance')).resolves.toBe(true);
  });

  it('measureChannel devuelve solo z, un punto por frecuencia', async () => {
    const pts = await plugin.measureChannel({ analyzerIp: '', startFreq: 1000, stopFreq: 100000, points: 11, sweepType: 'LOG' });
    expect(pts).toHaveLength(11);
    expect(Object.keys(pts[0].values)).toEqual(['z']);
    expect(pts[0].values.z).toBeCloseTo(randlesImpedance(1000));
  });
});
