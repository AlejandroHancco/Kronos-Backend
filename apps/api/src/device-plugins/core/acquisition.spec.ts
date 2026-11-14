import {
  acquisitionOf, estimateAcquisitionSeconds, formatSi, parseAcquisition, rangesError, requestsFor, snapshotOf, sweepXs,
  type AcquisitionMetadata,
} from './acquisition';

const sweep = (over: Partial<Record<string, unknown>> = {}) => ({
  kind: 'sweep',
  variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia', rangeMinimum: 9000, rangeMaximum: 3e9 },
  points: { minimum: 401, maximum: 401 },
  scales: ['LIN'],
  secondsPerPoint: 0.005,
  ...over,
});
const E4402B = parseAcquisition('a', sweep());
const HIOKI = parseAcquisition('a', sweep({
  variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia', rangeMinimum: 4, rangeMaximum: 5e6 },
  points: { minimum: 1, maximum: 801 }, scales: ['LIN', 'LOG'], secondsPerPoint: 0.01,
}));
const SINGLE = parseAcquisition('a', { kind: 'single', secondsPerReading: 1 });

describe('parseAcquisition', () => {
  it('acepta sweep y single', () => {
    expect(E4402B.kind).toBe('sweep');
    expect(SINGLE).toEqual({ kind: 'single', secondsPerReading: 1 });
  });
  it.each([
    [undefined, /a: debe ser un objeto/],
    [{ kind: 'stream' }, /a.kind/],
    [sweep({ variable: { name: 'frequency', unit: 'Hz', label: 'F', rangeMinimum: 10, rangeMaximum: 10 } }), /rangeMinimum/],
    [sweep({ points: { minimum: 0, maximum: 10 } }), /points.minimum/],
    [sweep({ points: { minimum: 20, maximum: 10 } }), /points/],
    [sweep({ points: { minimum: 1.5, maximum: 10 } }), /points.minimum/],
    [sweep({ scales: [] }), /scales/],
    [sweep({ scales: ['LIN', 'EXP'] }), /scales/],
    [sweep({ secondsPerPoint: 0 }), /secondsPerPoint/],
    [{ kind: 'single', secondsPerReading: -1 }, /secondsPerReading/],
    [sweep({ variable: { name: 'Freq Hz', unit: 'Hz', label: 'F', rangeMinimum: 1, rangeMaximum: 2 } }), /variable.name/],
  ])('rechaza declaraciones inválidas (%#)', (raw, msg) => {
    expect(() => parseAcquisition('a', raw)).toThrow(msg);
  });
});

describe('formatSi', () => {
  it.each([[9000, 'Hz', '9 kHz'], [3e9, 'Hz', '3 GHz'], [4, 'Hz', '4 Hz'], [1500000, 'Hz', '1.5 MHz'], [0.5, 'V', '0.5 V']])(
    '%p %s → %s', (v, u, out) => expect(formatSi(v, u)).toBe(out),
  );
});

describe('sweepXs', () => {
  it('lineal incluye extremos', () => expect(sweepXs(0, 10, 3, 'LIN')).toEqual([0, 5, 10]));
  it('logarítmico', () => expect(sweepXs(1, 100, 3, 'LOG')).toEqual([1, 10, 100]));
  it('un punto', () => expect(sweepXs(7, 9, 1, 'LIN')).toEqual([7]));
});

describe('rangesError', () => {
  const r = (start: number, stop: number, points = 401, scale = 'LIN') => ({ start, stop, points, scale });
  it('acepta un rango válido', () => expect(rangesError(E4402B, [r(9000, 1e9)], 'Agilent E4402B')).toBeNull());
  it('sweep sin rangos', () => expect(rangesError(E4402B, [], 'X')).toBe('Indica al menos un rango de barrido'));
  it('fuera del rango de la variable', () =>
    expect(rangesError(E4402B, [r(1000, 1e9)], 'Agilent E4402B')).toBe('Agilent E4402B mide Frecuencia entre 9 kHz y 3 GHz'));
  it('puntos fijos', () =>
    expect(rangesError(E4402B, [r(9000, 1e9, 801)], 'Agilent E4402B')).toBe('Agilent E4402B usa siempre 401 puntos'));
  it('puntos en rango', () =>
    expect(rangesError(HIOKI, [r(10, 100, 900)], 'Hioki IM3570')).toBe('Hioki IM3570 admite entre 1 y 801 puntos'));
  it('escala no permitida', () =>
    expect(rangesError(E4402B, [r(9000, 1e9, 401, 'LOG')], 'Agilent E4402B'))
      .toBe('Agilent E4402B no admite escala LOG (permitidas: LIN)'));
  it('single con rangos', () =>
    expect(rangesError(SINGLE, [r(1, 2, 1)], 'Sensor')).toBe('Sensor toma lecturas puntuales; no admite rangos de barrido'));
  it('single sin rangos', () => expect(rangesError(SINGLE, [], 'Sensor')).toBeNull());
});

describe('requestsFor', () => {
  it('sweep: una petición por rango', () =>
    expect(requestsFor(HIOKI, [{ start: 10, stop: 100, points: 5, scale: 'LOG' }]))
      .toEqual([{ kind: 'sweep', start: 10, stop: 100, points: 5, scale: 'LOG' }]));
  it('single: una lectura', () => expect(requestsFor(SINGLE, [])).toEqual([{ kind: 'single' }]));
});

describe('estimateAcquisitionSeconds', () => {
  it('sweep con selector: canales × (mux + Σ(setup + puntos·t))', () =>
    expect(estimateAcquisitionSeconds(HIOKI, [{ points: 801 }], 2, true)).toBe(Math.ceil(2 * (1.5 + 1 + 8.01))));
  it('sweep sin selector no suma el cambio de canal', () =>
    expect(estimateAcquisitionSeconds(HIOKI, [{ points: 801 }], 1, false)).toBe(Math.ceil(1 + 8.01)));
  it('single', () => expect(estimateAcquisitionSeconds(SINGLE, [], 3, true)).toBe(Math.ceil(3 * (1.5 + 1))));
});

describe('snapshotOf / acquisitionOf', () => {
  it('snapshot sin límites', () =>
    expect(snapshotOf(E4402B)).toEqual({ kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } }));
  it('single', () => expect(snapshotOf(SINGLE)).toEqual({ kind: 'single' }));
  it('acquisitionOf toma el primer sensor', () => {
    const d = { sensors: [{ acquisition: SINGLE }] } as any;
    expect(acquisitionOf(d)).toBe(SINGLE);
    expect(acquisitionOf({ sensors: [] } as any)).toBeNull();
  });
});
