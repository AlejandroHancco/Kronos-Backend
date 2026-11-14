import { SimulatedTemperaturePlugin, dailyCurve } from './sim-temperature.plugin';

const ctx = { id: 'd1', name: 'T', ip: null, configuration: {} };

describe('SimulatedTemperaturePlugin', () => {
  it('declara una lectura puntual', () => {
    expect(new SimulatedTemperaturePlugin().describe().sensors[0].acquisition).toEqual({ kind: 'single', secondsPerReading: 1 });
  });
  it('devuelve un único punto sin x con temperatura y humedad', async () => {
    const p = new SimulatedTemperaturePlugin();
    p.randomUnit = () => 0;
    p.now = () => new Date('2026-10-21T15:00:00');
    const points = await p.getSensorData(ctx, { kind: 'single' });
    expect(points).toHaveLength(1);
    expect(points[0].x).toBeUndefined();
    expect(points[0].values.temperature).toBeCloseTo(dailyCurve(15, 18, 28), 6);
    expect(points[0].values.humidity).toBeCloseTo(dailyCurve(15, 90, 60), 6);
  });
  it('máximo de temperatura a las 15 h y mínimo a las 3 h', () => {
    expect(dailyCurve(15, 18, 28)).toBeCloseTo(28, 6);
    expect(dailyCurve(3, 18, 28)).toBeCloseTo(18, 6);
  });
  it('rechaza barridos', async () => {
    await expect(new SimulatedTemperaturePlugin().getSensorData(ctx, { kind: 'sweep', start: 1, stop: 2, points: 2, scale: 'LIN' }))
      .rejects.toThrow('solo hace lecturas puntuales');
  });
});
