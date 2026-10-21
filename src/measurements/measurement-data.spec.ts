import {
  buildMeasurementData, channelNumbersOf, MAX_POSTED_POINTS, parseAcquisitionSnapshot, parseSensorValues, postedMeasurementError,
  storedPointsOf,
} from './measurement-data';

describe('channelNumbersOf', () => {
  it('devuelve los números de canal medidos, ordenados ascendentemente', () => {
    expect(channelNumbersOf([{ channelNumber: 5 }, { channelNumber: 1 }, { channelNumber: 3 }])).toEqual([1, 3, 5]);
  });
  it('arreglo vacío → []', () => {
    expect(channelNumbersOf([])).toEqual([]);
  });
});

describe('buildMeasurementData', () => {
  it('fusiona canales por x en 16 slots por valor declarado', () => {
    const data = buildMeasurementData([
      { channel: 1, points: [{ x: 2000, values: { g: 2, b: 20 } }, { x: 1000, values: { g: 1, b: 10 } }] },
      { channel: 3, points: [{ x: 1000, values: { g: 3, b: 30 } }] },
      { channel: 4, points: null },
    ], ['g', 'b']);
    expect(data.map((p) => p.x)).toEqual([1000, 2000]);
    expect(data[0].values.g).toHaveLength(16);
    expect(data[0].values.g.slice(0, 4)).toEqual([1, 0, 3, 0]);
    expect(data[1].values.b[0]).toBe(20);
  });
  it('ignora valores no declarados y rellena con 0 los faltantes', () => {
    const [p] = buildMeasurementData([{ channel: 1, points: [{ x: 5, values: { z: 7, extra: 9 } }] }], ['z', 'phase']);
    expect(Object.keys(p.values)).toEqual(['z', 'phase']);
    expect(p.values.z[0]).toBe(7);
    expect(p.values.phase[0]).toBe(0);
  });
  it('un punto sin x (lectura puntual) va primero y no lleva x', () => {
    const data = buildMeasurementData([
      { channel: 1, points: [{ x: 10, values: { z: 1 } }, { values: { z: 2 } }] },
      { channel: 2, points: [{ values: { z: 3 } }] },
    ], ['z']);
    expect(data).toHaveLength(2);
    expect('x' in data[0]).toBe(false);
    expect(data[0].values.z.slice(0, 2)).toEqual([2, 3]);
    expect(data[1].x).toBe(10);
  });
});

describe('parseSensorValues / storedPointsOf', () => {
  it('parsea metas válidas y descarta basura', () => {
    expect(parseSensorValues([{ name: 'z', unit: 'Ω' }, { name: 1 }, null])).toEqual([{ name: 'z', unit: 'Ω' }]);
    expect(parseSensorValues(null)).toEqual([]);
  });
  it('acepta puntos con x numérico o sin x', () => {
    expect(storedPointsOf([{ x: 1, values: { z: [1] } }, { values: { z: [2] } }, { x: 'a', values: { z: [3] } }])).toEqual([
      { x: 1, values: { z: [1] } },
      { values: { z: [2] } },
    ]);
    expect(storedPointsOf({})).toEqual([]);
  });
  it('ignora los puntos legados { frequency, g, b }', () => {
    const legado = { frequency: 2, g: [1], b: [2] }; // punto legado
    expect(storedPointsOf([legado, { x: 1, values: { z: [1] } }])).toEqual([{ x: 1, values: { z: [1] } }]);
  });
});

describe('parseAcquisitionSnapshot', () => {
  const freq = { kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } };
  it('devuelve el snapshot guardado', () => {
    expect(parseAcquisitionSnapshot({ kind: 'single' })).toEqual({ kind: 'single' });
    expect(parseAcquisitionSnapshot({ kind: 'sweep', variable: { name: 'wavelength', unit: 'nm', label: 'Longitud de onda', rangeMinimum: 1 } }))
      .toEqual({ kind: 'sweep', variable: { name: 'wavelength', unit: 'nm', label: 'Longitud de onda' } });
    expect(parseAcquisitionSnapshot({ kind: 'sweep', variable: { name: 'v', unit: 'V' } }))
      .toEqual({ kind: 'sweep', variable: { name: 'v', unit: 'V', label: 'v' } });
  });
  it('inválido o ausente → barrido en frecuencia', () => {
    expect(parseAcquisitionSnapshot(null)).toEqual(freq);
    expect(parseAcquisitionSnapshot({ kind: 'sweep' })).toEqual(freq);
    expect(parseAcquisitionSnapshot('x')).toEqual(freq);
  });
});

describe('postedMeasurementError (POST /measurements)', () => {
  const sv = [{ name: 'g', unit: 'S' }, { name: 'b', unit: 'S', label: 'Susceptancia' }];
  const pt = (values: Record<string, unknown>, x: unknown = 1000) => ({ x, values });
  const ok = [pt({ g: [1, 2], b: [3, 4] })];
  const sweep = { kind: 'sweep' as const, variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } };
  const single = { kind: 'single' as const };

  it('acepta un payload válido', () => {
    expect(postedMeasurementError(sv, ok, sweep)).toBeNull();
    expect(postedMeasurementError(sv, [], sweep)).toBeNull();
  });
  it('exige sensorValues no vacío y bien formado', () => {
    expect(postedMeasurementError(undefined, ok, sweep)).toMatch(/sensorValues/);
    expect(postedMeasurementError([], ok, sweep)).toMatch(/sensorValues/);
    expect(postedMeasurementError([{ name: 'g' }], ok, sweep)).toMatch(/sensorValues\[0\]/);
    expect(postedMeasurementError([{ name: '', unit: 'S' }], ok, sweep)).toMatch(/sensorValues\[0\]/);
    expect(postedMeasurementError([{ name: 'g', unit: 'S', label: 5 }], ok, sweep)).toMatch(/sensorValues\[0\]/);
    expect(postedMeasurementError([{ name: 'g', unit: 'S' }, { name: 'g', unit: 'S' }], ok, sweep)).toMatch(/repetido/);
  });
  it('barrido: exige el formato { x, values } con x finito', () => {
    expect(postedMeasurementError(sv, [{ frequency: 1, g: [1], b: [2] }], sweep)).toMatch(/data\[0\]/); // formato legado
    expect(postedMeasurementError(sv, [pt({ g: [1], b: [1] }, 'x')], sweep)).toMatch(/data\[0\] debe usar el formato \{ x: número/);
    expect(postedMeasurementError(sv, [pt({ g: [1], b: [1] }, Infinity)], sweep)).toMatch(/data\[0\]/);
    expect(postedMeasurementError(sv, [{ values: { g: [1], b: [1] } }], sweep)).toMatch(/data\[0\]/);
    expect(postedMeasurementError(sv, 'nope', sweep)).toMatch(/data/);
  });
  it('lectura puntual: exige exactamente un punto { values } sin x', () => {
    const svT = [{ name: 't', unit: '°C' }];
    expect(postedMeasurementError(svT, [{ values: { t: [1] } }], single)).toBeNull();
    expect(postedMeasurementError(svT, [], single)).toMatch(/exactamente un punto \{ values \} sin x/);
    expect(postedMeasurementError(svT, [{ values: { t: [1] } }, { values: { t: [2] } }], single)).toMatch(/exactamente un punto \{ values \} sin x/);
    expect(postedMeasurementError(svT, [pt({ t: [1] })], single)).toMatch(/exactamente un punto \{ values \} sin x/);
  });
  it('rechaza valores no declarados y exige todos los declarados', () => {
    expect(postedMeasurementError(sv, [pt({ g: [1], b: [1], z: [1] })], sweep)).toMatch(/"z" no está declarado/);
    expect(postedMeasurementError(sv, [pt({ g: [1] })], sweep)).toMatch(/falta el valor "b"/);
  });
  it('cada valor es un arreglo de a lo más 16 números finitos', () => {
    expect(postedMeasurementError(sv, [pt({ g: 1, b: [1] })], sweep)).toMatch(/hasta 16 números/);
    expect(postedMeasurementError(sv, [pt({ g: Array(17).fill(0), b: [1] })], sweep)).toMatch(/hasta 16 números/);
    expect(postedMeasurementError(sv, [pt({ g: [1, NaN], b: [1] })], sweep)).toMatch(/hasta 16 números/);
    expect(postedMeasurementError(sv, [pt({ g: ['1'], b: [1] })], sweep)).toMatch(/hasta 16 números/);
  });
  it('limita la cantidad de puntos', () => {
    const many = Array.from({ length: MAX_POSTED_POINTS + 1 }, (_, i) => pt({ g: [1], b: [1] }, i));
    expect(postedMeasurementError(sv, many, sweep)).toMatch(/como máximo 10000 puntos/);
  });
});
