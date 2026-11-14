import type { MeasuredPoint } from './contract';
import type { AcquisitionSnapshot } from './acquisition';
import { CHANNEL_SLOTS, type MeasurementValueMeta } from './experiment-config';

/** Formato de Measurement.data: por valor de la variable (`x`; sin `x` en lecturas puntuales), 16 slots por sensorValue. */
export interface StoredMeasurementPoint { x?: number; values: Record<string, number[]> }
export interface ChannelResult { channel: number; points: MeasuredPoint[] | null }

export function buildMeasurementData(results: ChannelResult[], valueNames: string[]): StoredMeasurementPoint[] {
  const rows = new Map<number | undefined, Record<string, number[]>>();
  for (const { channel, points } of results) {
    if (!points) continue;
    for (const p of points) {
      let row = rows.get(p.x);
      if (!row) {
        row = Object.fromEntries(valueNames.map((n) => [n, Array<number>(CHANNEL_SLOTS).fill(0)]));
        rows.set(p.x, row);
      }
      for (const n of valueNames) row[n][channel - 1] = Number.isFinite(p.values[n]) ? p.values[n] : 0;
    }
  }
  return [...rows.entries()]
    .sort(([a], [b]) => (a ?? -Infinity) - (b ?? -Infinity))
    .map(([x, values]) => (x === undefined ? { values } : { x, values }));
}

export function parseSensorValues(json: unknown): MeasurementValueMeta[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((v) =>
    v && typeof v === 'object' && typeof (v as any).name === 'string' && typeof (v as any).unit === 'string'
      ? [{ name: (v as any).name, unit: (v as any).unit, ...(typeof (v as any).label === 'string' ? { label: (v as any).label } : {}) }]
      : [],
  );
}

const isValuesRecord = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStoredPoint = (p: unknown): p is StoredMeasurementPoint =>
  !!p && typeof p === 'object' && isValuesRecord((p as any).values)
  && ((p as any).x === undefined || typeof (p as any).x === 'number')
  && !('frequency' in (p as object)); // legado {frequency, g, b}: se ignora

const FREQUENCY_SWEEP: AcquisitionSnapshot = { kind: 'sweep', variable: { name: 'frequency', unit: 'Hz', label: 'Frecuencia' } };

/** Snapshot de adquisición de una medición; inválido o ausente → barrido en frecuencia (mediciones previas a la migración). */
export function parseAcquisitionSnapshot(json: unknown): AcquisitionSnapshot {
  const o = json as any;
  if (o && o.kind === 'single') return { kind: 'single' };
  if (o && o.kind === 'sweep' && o.variable && typeof o.variable.name === 'string' && typeof o.variable.unit === 'string') {
    return { kind: 'sweep', variable: { name: o.variable.name, unit: o.variable.unit, label: String(o.variable.label ?? o.variable.name) } };
  }
  return FREQUENCY_SWEEP;
}

/** Puntos del formato nuevo ({x?, values}); descarta los legados ({frequency, g, b}) y basura. */
export function storedPointsOf(json: unknown): StoredMeasurementPoint[] {
  return Array.isArray(json) ? json.filter(isStoredPoint) : [];
}

/** Lista plana de canales medidos (número de canal, ascendente) a partir de las filas de `measurementChannels`. */
export function channelNumbersOf(channels: { channelNumber: number }[]): number[] {
  return channels.map((c) => c.channelNumber).sort((a, b) => a - b);
}

/** Tope de puntos aceptados en POST /measurements. */
export const MAX_POSTED_POINTS = 10_000;

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Valida el contenido de POST /measurements: `sensorValues` no vacío ({name, unit, label?}),
 * y según la adquisición (`acquisition`), o un único punto `{ values }` sin x (lectura
 * puntual) o puntos `{x, values}` con x finito (barrido), cada valor un arreglo de hasta
 * 16 números finitos. Devuelve el primer error (en español) o null.
 */
export function postedMeasurementError(sensorValues: unknown, data: unknown, acquisition: AcquisitionSnapshot): string | null {
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
  if (!Array.isArray(data)) return 'data debe ser un arreglo de puntos { x, values }';
  if (data.length > MAX_POSTED_POINTS) return `data admite como máximo ${MAX_POSTED_POINTS} puntos (recibidos ${data.length})`;
  if (acquisition.kind === 'single') {
    if (data.length !== 1 || !isStoredPoint(data[0]) || data[0].x !== undefined) {
      return 'Una lectura puntual tiene exactamente un punto { values } sin x';
    }
  }
  for (const [i, p] of data.entries()) {
    if (!isStoredPoint(p) || (acquisition.kind === 'sweep' && !isFiniteNumber(p.x))) {
      return `data[${i}] debe usar el formato { x: número, values: { … } }`;
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
