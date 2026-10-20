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
