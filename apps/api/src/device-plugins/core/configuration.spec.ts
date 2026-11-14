import { configurationPatchErrors, effectiveConfiguration, splitPatch } from './configuration';
import type { ConfigurationParameterMetadata as P } from './device-plugin.interface';

const params: P[] = [
  { name: 'mode', label: 'Modo', type: 'string', unit: '', default: 'ANALyzer', access: 'read-only', storage: 'fixed' },
  { name: 'points', label: 'Puntos', type: 'integer', unit: '', rangeMinimum: 1, rangeMaximum: 801, rangeStep: 1, default: 801, access: 'read-write', storage: 'persisted' },
  { name: 'c', label: 'C', type: 'double', unit: 'nF', rangeMinimum: 0.001, rangeMaximum: 1e6, default: 2, access: 'read-write', storage: 'persisted' },
  { name: 'sweep', label: 'Barrido', type: 'string', unit: '', allowedValues: ['LIN', 'LOG'], default: 'LOG', access: 'read-write', storage: 'persisted' },
  { name: 'channel', label: 'Canal', type: 'integer', unit: '', rangeMinimum: 1, rangeMaximum: 16, rangeStep: 1, access: 'read-write', storage: 'live' },
];

describe('effectiveConfiguration', () => {
  it('defaults + valores guardados válidos; ignora inválidos/desconocidos; omite live', () => {
    expect(effectiveConfiguration(params, { points: 101, c: -1, extra: 1, channel: 4 }))
      .toEqual({ mode: 'ANALyzer', points: 101, c: 2, sweep: 'LOG' });
    expect(effectiveConfiguration(params, null)).toEqual({ mode: 'ANALyzer', points: 801, c: 2, sweep: 'LOG' });
  });
});

describe('configurationPatchErrors', () => {
  it('mensajes en español por cada violación', () => {
    expect(configurationPatchErrors(params, {})).toEqual(['No hay valores para configurar']);
    expect(configurationPatchErrors(params, { foo: 1 })).toEqual(['Parámetro de configuración desconocido: "foo"']);
    expect(configurationPatchErrors(params, { mode: 'X' })).toEqual(['"Modo" es de solo lectura']);
    expect(configurationPatchErrors(params, { points: 1.5 })).toEqual(['"Puntos" debe ser un número entero']);
    expect(configurationPatchErrors(params, { points: 900 })).toEqual(['"Puntos" debe estar entre 1 y 801']);
    expect(configurationPatchErrors(params, { c: 0 })).toEqual(['"C" debe estar entre 0.001 y 1000000 nF']);
    expect(configurationPatchErrors(params, { c: '2' })).toEqual(['"C" debe ser un número']);
    expect(configurationPatchErrors(params, { sweep: 'EXP' })).toEqual(['"Barrido" debe ser uno de: LIN, LOG']);
    expect(configurationPatchErrors(params, { channel: 3, points: 11 })).toEqual([]);
  });
  it('splitPatch separa persistidos y live', () => {
    expect(splitPatch(params, { channel: 3, points: 11 })).toEqual({ persisted: { points: 11 }, live: { channel: 3 } });
  });
});
