import { buildMeasurementData, MAX_POSTED_POINTS, parseSensorValues, postedMeasurementError, storedPointsOf } from './measurement-data';

describe('buildMeasurementData', () => {
  it('fusiona canales por frecuencia en 16 slots por valor declarado', () => {
    const data = buildMeasurementData([
      { channel: 1, points: [{ frequency: 2000, values: { g: 2, b: 20 } }, { frequency: 1000, values: { g: 1, b: 10 } }] },
      { channel: 3, points: [{ frequency: 1000, values: { g: 3, b: 30 } }] },
      { channel: 4, points: null },
    ], ['g', 'b']);
    expect(data.map((p) => p.frequency)).toEqual([1000, 2000]);
    expect(data[0].values.g).toHaveLength(16);
    expect(data[0].values.g.slice(0, 4)).toEqual([1, 0, 3, 0]);
    expect(data[1].values.b[0]).toBe(20);
  });
  it('ignora valores no declarados y rellena con 0 los faltantes', () => {
    const [p] = buildMeasurementData([{ channel: 1, points: [{ frequency: 5, values: { z: 7, extra: 9 } }] }], ['z', 'phase']);
    expect(Object.keys(p.values)).toEqual(['z', 'phase']);
    expect(p.values.z[0]).toBe(7);
    expect(p.values.phase[0]).toBe(0);
  });
});

describe('parseSensorValues / storedPointsOf', () => {
  it('parsea metas válidas y descarta basura', () => {
    expect(parseSensorValues([{ name: 'z', unit: 'Ω' }, { name: 1 }, null])).toEqual([{ name: 'z', unit: 'Ω' }]);
    expect(parseSensorValues(null)).toEqual([]);
  });
  it('solo acepta puntos del formato nuevo', () => {
    expect(storedPointsOf([{ frequency: 1, values: { z: [1] } }, { frequency: 2, g: [1], b: [2] }])).toHaveLength(1);
    expect(storedPointsOf({})).toEqual([]);
  });
});

describe('postedMeasurementError (POST /measurements)', () => {
  const sv = [{ name: 'g', unit: 'S' }, { name: 'b', unit: 'S', label: 'Susceptancia' }];
  const pt = (values: Record<string, unknown>, frequency: unknown = 1000) => ({ frequency, values });
  const ok = [pt({ g: [1, 2], b: [3, 4] })];

  it('acepta un payload válido', () => {
    expect(postedMeasurementError(sv, ok)).toBeNull();
    expect(postedMeasurementError(sv, [])).toBeNull();
  });
  it('exige sensorValues no vacío y bien formado', () => {
    expect(postedMeasurementError(undefined, ok)).toMatch(/sensorValues/);
    expect(postedMeasurementError([], ok)).toMatch(/sensorValues/);
    expect(postedMeasurementError([{ name: 'g' }], ok)).toMatch(/sensorValues\[0\]/);
    expect(postedMeasurementError([{ name: '', unit: 'S' }], ok)).toMatch(/sensorValues\[0\]/);
    expect(postedMeasurementError([{ name: 'g', unit: 'S', label: 5 }], ok)).toMatch(/sensorValues\[0\]/);
    expect(postedMeasurementError([{ name: 'g', unit: 'S' }, { name: 'g', unit: 'S' }], ok)).toMatch(/repetido/);
  });
  it('exige el formato { frequency, values } con frecuencia finita', () => {
    expect(postedMeasurementError(sv, [{ frequency: 1, g: [1], b: [2] }])).toMatch(/data\[0\]/);
    expect(postedMeasurementError(sv, [pt({ g: [1], b: [1] }, 'x')])).toMatch(/data\[0\]/);
    expect(postedMeasurementError(sv, 'nope')).toMatch(/data/);
  });
  it('rechaza valores no declarados y exige todos los declarados', () => {
    expect(postedMeasurementError(sv, [pt({ g: [1], b: [1], z: [1] })])).toMatch(/"z" no está declarado/);
    expect(postedMeasurementError(sv, [pt({ g: [1] })])).toMatch(/falta el valor "b"/);
  });
  it('cada valor es un arreglo de a lo más 16 números finitos', () => {
    expect(postedMeasurementError(sv, [pt({ g: 1, b: [1] })])).toMatch(/hasta 16 números/);
    expect(postedMeasurementError(sv, [pt({ g: Array(17).fill(0), b: [1] })])).toMatch(/hasta 16 números/);
    expect(postedMeasurementError(sv, [pt({ g: [1, NaN], b: [1] })])).toMatch(/hasta 16 números/);
    expect(postedMeasurementError(sv, [pt({ g: ['1'], b: [1] })])).toMatch(/hasta 16 números/);
  });
  it('limita la cantidad de puntos', () => {
    const many = Array.from({ length: MAX_POSTED_POINTS + 1 }, (_, i) => pt({ g: [1], b: [1] }, i));
    expect(postedMeasurementError(sv, many)).toMatch(/como máximo 10000 puntos/);
  });
});
