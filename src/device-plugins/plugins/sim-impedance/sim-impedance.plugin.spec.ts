import { SimulatedImpedancePlugin, randlesImpedance, randlesParamsOf, CONCRETE_LIKE } from './sim-impedance.plugin';
import { sweepXs } from '../../core/acquisition';

describe('randlesImpedance', () => {
  it('≈ Rs+Rp a baja frecuencia y ≈ Rs a muy alta frecuencia', () => {
    expect(randlesImpedance(0.01)).toBeCloseTo(CONCRETE_LIKE.rs + CONCRETE_LIKE.rp, -1);
    expect(randlesImpedance(1e9)).toBeLessThan(CONCRETE_LIKE.rs * 1.01);
  });
  it('decrece monótonamente con la frecuencia', () => {
    const z = sweepXs(10, 5e6, 50, 'LOG').map((f) => randlesImpedance(f));
    for (let i = 1; i < z.length; i++) expect(z[i]).toBeLessThan(z[i - 1]);
  });
});

describe('SimulatedImpedancePlugin', () => {
  const sweep = { kind: 'sweep', start: 1000, stop: 100000, points: 11, scale: 'LOG' } as const;
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
    pts.forEach((p) => expect(p.values.z).toBeCloseTo(randlesImpedance(p.x!, CONCRETE_LIKE)));
  });

  it('usa Rp de la configuración del dispositivo', async () => {
    const [p] = await new SimulatedImpedancePlugin().getSensorData(
      device({ rs: 150, rp: 40000, c: 2, noisePercent: 0 }),
      { kind: 'sweep', start: 0.01, stop: 0.01, points: 1, scale: 'LIN' },
    );
    expect(p.values.z).toBeCloseTo(40150, -1);
  });

  it('ruido: z·(1 + 2·randomUnit()·noisePercent/100)', async () => {
    const plugin = new SimulatedImpedancePlugin();
    plugin.randomUnit = () => 0.5;
    const [p] = await plugin.getSensorData(
      device({ rs: 150, rp: 20000, c: 2, noisePercent: 1 }),
      { kind: 'sweep', start: 1000, stop: 1000, points: 1, scale: 'LIN' },
    );
    expect(p.values.z).toBeCloseTo(randlesImpedance(1000, CONCRETE_LIKE) * 1.01);
  });

  it('devuelve puntos { x, values } y rechaza lecturas puntuales', async () => {
    const plugin = new SimulatedImpedancePlugin();
    const pts = await plugin.getSensorData(device({ rs: 150, rp: 20000, c: 2, noisePercent: 0 }), sweep);
    expect(pts[0]).toEqual({ x: 1000, values: { z: expect.any(Number) } });
    await expect(plugin.getSensorData(device({ rs: 150, rp: 20000, c: 2, noisePercent: 0 }), { kind: 'single' }))
      .rejects.toThrow('El simulador de impedancia solo hace barridos');
  });
});
