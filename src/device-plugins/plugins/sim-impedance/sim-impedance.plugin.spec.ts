import { SimulatedImpedancePlugin, randlesImpedance, randlesParamsOf, sweepFrequencies, CONCRETE_LIKE } from './sim-impedance.plugin';

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
  const sweep = { startFreq: 1000, stopFreq: 100000, points: 11, sweepType: 'LOG' };
  const device = (configuration: Record<string, number>) => ({ id: 's', name: 'Sim', ip: null, configuration });

  it('se describe como simulado, sin IP, sin actuators ni selector, con z en Ω y 4 parámetros', () => {
    const d = new SimulatedImpedancePlugin().describe();
    expect(d).toMatchObject({
      deviceType: 'sim-impedance', shortName: 'Simulador (Randles)', simulated: true, connection: { requiresIp: false }, actuators: [],
    });
    expect(d.channelSelector).toBeUndefined();
    expect(d.description).toMatch(/SIMULADO/);
    expect(d.sensors[0].sensorValues).toEqual([
      expect.objectContaining({ name: 'z', unit: 'Ω', type: 'double', rangeMinimum: 0 }),
    ]);
    expect(d.configuration.map((p) => p.name)).toEqual(['rs', 'rp', 'c', 'noisePercent']);
  });

  it('testConnection siempre true', async () => {
    await expect(new SimulatedImpedancePlugin().testConnection({ ip: null })).resolves.toBe(true);
  });

  it('randlesParamsOf convierte c de nF a F', () => {
    expect(randlesParamsOf({ rs: 150, rp: 20000, c: 2, noisePercent: 0 })).toEqual(CONCRETE_LIKE);
  });

  it('getSensorData sin ruido devuelve solo z del modelo de la configuración', async () => {
    const pts = await new SimulatedImpedancePlugin().getSensorData(device({ rs: 150, rp: 20000, c: 2, noisePercent: 0 }), sweep);
    expect(pts).toHaveLength(11);
    expect(Object.keys(pts[0].values)).toEqual(['z']);
    pts.forEach((p) => expect(p.values.z).toBeCloseTo(randlesImpedance(p.frequency, CONCRETE_LIKE)));
  });

  it('usa Rp de la configuración del dispositivo', async () => {
    const [p] = await new SimulatedImpedancePlugin().getSensorData(
      device({ rs: 150, rp: 40000, c: 2, noisePercent: 0 }),
      { startFreq: 0.01, stopFreq: 0.01, points: 1, sweepType: 'LIN' },
    );
    expect(p.values.z).toBeCloseTo(40150, -1);
  });

  it('ruido: z·(1 + 2·randomUnit()·noisePercent/100)', async () => {
    const plugin = new SimulatedImpedancePlugin();
    plugin.randomUnit = () => 0.5;
    const [p] = await plugin.getSensorData(
      device({ rs: 150, rp: 20000, c: 2, noisePercent: 1 }),
      { startFreq: 1000, stopFreq: 1000, points: 1, sweepType: 'LIN' },
    );
    expect(p.values.z).toBeCloseTo(randlesImpedance(1000, CONCRETE_LIKE) * 1.01);
  });
});
