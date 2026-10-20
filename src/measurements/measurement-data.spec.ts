import { buildMeasurementData, parseSensorValues, storedPointsOf } from './measurement-data';

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
