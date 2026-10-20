import { classifyMeasurement } from './kronos-watcher';

const pt = (f: number, values: Record<string, number[]>) => ({ frequency: f, values });
const slots = (first: number) => [first, ...Array(15).fill(0)];

describe('classifyMeasurement', () => {
  it('correct cuando los valores declarados no son nulos (canales no medidos se ignoran)', () => {
    expect(classifyMeasurement([pt(1, { z: slots(100) }), pt(2, { z: slots(90) })], [1], ['z'])).toEqual({ severity: 'correct' });
  });
  it('solo inspecciona las claves declaradas', () => {
    const data = [pt(1, { g: slots(0), z: slots(5) })];
    expect(classifyMeasurement(data, [1], ['z']).severity).toBe('correct');
    expect(classifyMeasurement(data, [1], ['g']).severity).toBe('error');
  });
  it('warning entre 30 % y 80 % de nulos', () => {
    const data = [pt(1, { g: slots(1), b: slots(0) })];
    expect(classifyMeasurement(data, [1], ['g', 'b']).severity).toBe('warning');
  });
  it('error sin datos o sin claves declaradas', () => {
    expect(classifyMeasurement([], [1], ['z'])).toMatchObject({ severity: 'error', bare: true });
    expect(classifyMeasurement([pt(1, { z: slots(1) })], [1], [])).toMatchObject({ severity: 'error', bare: true });
  });
});
