import type { MeasuredPoint } from '../device-plugins/device-plugin.interface';
import { CHANNEL_SLOTS, type MeasurementValueMeta } from '../device-plugins/experiment-config';
export { CHANNEL_SLOTS, type MeasurementValueMeta };

/** Formato de Measurement.data: por frecuencia, un arreglo de 16 slots por sensorValue declarado. */
export interface StoredMeasurementPoint { frequency: number; values: Record<string, number[]> }
export interface ChannelResult { channel: number; points: MeasuredPoint[] | null }

export function buildMeasurementData(results: ChannelResult[], valueNames: string[]): StoredMeasurementPoint[] {
  const byFreq = new Map<number, Record<string, number[]>>();
  for (const { channel, points } of results) {
    if (!points) continue;
    for (const p of points) {
      let row = byFreq.get(p.frequency);
      if (!row) {
        row = Object.fromEntries(valueNames.map((n) => [n, Array<number>(CHANNEL_SLOTS).fill(0)]));
        byFreq.set(p.frequency, row);
      }
      for (const n of valueNames) row[n][channel - 1] = Number.isFinite(p.values[n]) ? p.values[n] : 0;
    }
  }
  return [...byFreq.entries()].sort(([a], [b]) => a - b).map(([frequency, values]) => ({ frequency, values }));
}

export function parseSensorValues(json: unknown): MeasurementValueMeta[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((v) =>
    v && typeof v === 'object' && typeof (v as any).name === 'string' && typeof (v as any).unit === 'string'
      ? [{ name: (v as any).name, unit: (v as any).unit, ...(typeof (v as any).label === 'string' ? { label: (v as any).label } : {}) }]
      : [],
  );
}

const isStoredPoint = (p: unknown): p is StoredMeasurementPoint =>
  !!p && typeof p === 'object' && typeof (p as any).frequency === 'number'
  && !!(p as any).values && typeof (p as any).values === 'object' && !Array.isArray((p as any).values);

/** Puntos del formato nuevo; descarta los legados ({frequency, g, b}) y basura. */
export function storedPointsOf(json: unknown): StoredMeasurementPoint[] {
  return Array.isArray(json) ? json.filter(isStoredPoint) : [];
}

/** Tope de puntos (frecuencias) aceptados en POST /measurements. */
export const MAX_POSTED_POINTS = 10_000;

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Valida el contenido de POST /measurements: `sensorValues` no vacío ({name, unit, label?}),
 * y cada punto `{frequency, values}` con exactamente los valores declarados, cada uno un
 * arreglo de hasta 16 números finitos. Devuelve el primer error (en español) o null.
 */
export function postedMeasurementError(sensorValues: unknown, data: unknown): string | null {
  if (!Array.isArray(sensorValues) || sensorValues.length === 0) {
    return 'sensorValues es obligatorio y debe declarar al menos un valor ({ name, unit, label? })';
  }
  const names = new Set<string>();
  for (const [i, v] of sensorValues.entries()) {
    const ok = !!v && typeof v === 'object' && !Array.isArray(v)
      && typeof v.name === 'string' && v.name.trim() !== ''
      && typeof v.unit === 'string'
      && (v.label === undefined || typeof v.label === 'string');
    if (!ok) return `sensorValues[${i}] debe tener la forma { name: texto, unit: texto, label?: texto }`;
    if (names.has(v.name)) return `sensorValues: el nombre "${v.name}" está repetido`;
    names.add(v.name);
  }
  if (!Array.isArray(data)) return 'data debe ser un arreglo de puntos { frequency, values }';
  if (data.length > MAX_POSTED_POINTS) return `data admite como máximo ${MAX_POSTED_POINTS} puntos (recibidos ${data.length})`;
  for (const [i, p] of data.entries()) {
    if (!isStoredPoint(p) || !Number.isFinite(p.frequency)) {
      return `data[${i}] debe usar el formato { frequency: número, values: { … } }`;
    }
    for (const [name, arr] of Object.entries(p.values)) {
      if (!names.has(name)) return `data[${i}]: el valor "${name}" no está declarado en sensorValues`;
      if (!Array.isArray(arr) || arr.length > CHANNEL_SLOTS || !arr.every(isFiniteNumber)) {
        return `data[${i}].values.${name} debe ser un arreglo de hasta ${CHANNEL_SLOTS} números finitos`;
      }
    }
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(p.values, name)) return `data[${i}]: falta el valor "${name}" declarado en sensorValues`;
    }
  }
  return null;
}
