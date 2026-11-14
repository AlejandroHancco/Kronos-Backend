import { estimateSeconds } from './estimate';

const hiokiAcq = {
  kind: 'sweep' as const,
  variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia', rangeMinimum: 4, rangeMaximum: 5000000 },
  points: { minimum: 1, maximum: 801 },
  scales: ['LIN', 'LOG'] as const,
  secondsPerPoint: 0.01,
};

describe('estimateSeconds (desde la adquisición del dispositivo de medición)', () => {
  it('con selector: canales × (cambio de canal + setup + puntos·t)', () => {
    expect(estimateSeconds(hiokiAcq as any, [{ points: 801 }], 2, true)).toBe(Math.ceil(2 * (1.5 + 1 + 8.01)));
  });
  it('sin selector: no suma cambio de canal', () => {
    expect(estimateSeconds(hiokiAcq as any, [{ points: 801 }], 1, false)).toBe(Math.ceil(9.01));
  });
});
