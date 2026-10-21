import { SimulatedSpectrumPlugin, spectrumAt } from './sim-spectrum.plugin';

const ctxA = { id: 'a', name: 'Espectro A', ip: null, configuration: {} };
const ctxB = { id: 'b', name: 'Espectro B', ip: null, configuration: {} };
const req = { kind: 'sweep' as const, start: 1e6, stop: 2e6, points: 101, scale: 'LIN' as const };

describe('sim-spectrum', () => {
  it('devuelve 101 puntos, x de 1e6 a 2e6, con un pico entre -60 y -30 dBm', async () => {
    const p = new SimulatedSpectrumPlugin();
    p.randomUnit = () => 0;
    const points = await p.getSensorData(ctxA, req);
    expect(points).toHaveLength(101);
    expect(points[0].x).toBe(1e6);
    expect(points[100].x).toBe(2e6);
    const max = Math.max(...points.map((pt) => pt.values.amplitude));
    expect(max).toBeGreaterThanOrEqual(-60);
    expect(max).toBeLessThanOrEqual(-30);
  });

  it('lejos de los picos la amplitud está cerca del piso de ruido (-93..-87 dBm)', async () => {
    const p = new SimulatedSpectrumPlugin();
    p.randomUnit = () => 0;
    const points = await p.getSensorData(ctxA, req);
    const peakIndex = points.reduce((best, pt, i) => (pt.values.amplitude > points[best].values.amplitude ? i : best), 0);
    for (const [i, pt] of points.entries()) {
      if (Math.abs(i - peakIndex) > 20) {
        expect(pt.values.amplitude).toBeGreaterThanOrEqual(-93);
        expect(pt.values.amplitude).toBeLessThanOrEqual(-87);
      }
    }
  });

  it('dos dispositivos distintos ubican su pico más alto en x distintos', async () => {
    // Más puntos que en `req` para no confundir, por cuantización de la grilla, dos picos
    // continuos cercanos entre sí (a ~1,818,899 Hz, b ~1,815,774 Hz) en el mismo punto muestreado.
    const finerReq = { ...req, points: 401 };
    const p = new SimulatedSpectrumPlugin();
    p.randomUnit = () => 0;
    const pointsA = await p.getSensorData(ctxA, finerReq);
    const pointsB = await p.getSensorData(ctxB, finerReq);
    const peakXA = pointsA.reduce((best, pt) => (pt.values.amplitude > best.values.amplitude ? pt : best)).x;
    const peakXB = pointsB.reduce((best, pt) => (pt.values.amplitude > best.values.amplitude ? pt : best)).x;
    expect(peakXA).not.toBe(peakXB);
  });

  it('el mismo id siempre da la misma salida', async () => {
    const p = new SimulatedSpectrumPlugin();
    p.randomUnit = () => 0;
    const first = await p.getSensorData(ctxA, req);
    const second = await p.getSensorData(ctxA, req);
    expect(second).toEqual(first);
  });

  it('rechaza lecturas puntuales', async () => {
    const p = new SimulatedSpectrumPlugin();
    await expect(p.getSensorData(ctxA, { kind: 'single' })).rejects.toThrow('solo hace barridos');
  });

  it('spectrumAt: pico se desplaza con el seed', () => {
    const start = 1e6, stop = 2e6;
    const grid = Array.from({ length: 401 }, (_, i) => start + (stop - start) * (i / 400));
    const peakXFor = (seed: string) =>
      grid.reduce((best, f) => (spectrumAt(f, start, stop, seed) > spectrumAt(best, start, stop, seed) ? f : best), grid[0]);

    expect(peakXFor('a')).not.toBe(peakXFor('b'));

    const valuesA1 = grid.map((f) => spectrumAt(f, start, stop, 'a'));
    const valuesA2 = grid.map((f) => spectrumAt(f, start, stop, 'a'));
    expect(valuesA2).toEqual(valuesA1);
  });
});
