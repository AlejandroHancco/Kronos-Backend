import { toCsvCell, toCsvRow } from './csv.util';
import { parseAcquisitionSnapshot, parseSensorValues, storedPointsOf, type MeasurementValueMeta } from '../measurements/measurement-data';
import type { AcquisitionSnapshot } from '@app/laas-catalog';

const HEADER_BEFORE = ['measurement_id', 'taken_at', 'taken_by', 'preset', 'watcher_status'];
const HEADER_CHANNEL = ['channel', 'channel_alias'];
const HEADER_AFTER = ['concrete_mix', 'has_emulsifier', 'sample_age', 'temperature', 'humidity', 'notes'];

/** Columna de valor del CSV: un sensorValue declarado (name, unit) y su nombre de columna ASCII. */
export interface CsvValueColumn { name: string; unit: string; column: string }

/** Unidad → sufijo ASCII de columna: S→s (compatibilidad con g_s/b_s), Ω→ohm, kΩ→kohm, °→deg. */
export function unitSlug(unit: string): string {
  return unit.replace(/Ω/g, 'ohm').replace(/[µμ]/g, 'u').replace(/°/g, 'deg')
    .normalize('NFD').replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

/** Columnas de valor (en orden) para los sensorValues dados; deduplica por nombre de columna. */
export function valueColumnsFor(metas: MeasurementValueMeta[]): CsvValueColumn[] {
  const seen = new Set<string>();
  const cols: CsvValueColumn[] = [];
  for (const { name, unit } of metas) {
    const base = name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase();
    const slug = unitSlug(unit);
    const column = slug ? `${base}_${slug}` : base;
    if (!seen.has(column)) {
      seen.add(column);
      cols.push({ name, unit, column });
    }
  }
  return cols;
}

/** Columna de la variable de un barrido (p. ej. `frequency_hz`, `voltage_v`); `null` para lectura puntual (sin eje X). */
export const xColumnOf = (a: AcquisitionSnapshot): string | null =>
  a.kind === 'sweep' ? `${a.variable.name.replace(/[^a-zA-Z0-9_]+/g, '_').toLowerCase()}_${unitSlug(a.variable.unit)}` : null;

/** Clave de bloque: mediciones consecutivas con la misma adquisición comparten un único encabezado. */
export const blockKeyOf = (a: AcquisitionSnapshot): string =>
  a.kind === 'single' ? 'single' : `sweep:${a.variable.name}:${a.variable.unit}`;

export const csvHeader = (cols: CsvValueColumn[], xColumn: string | null): string[] =>
  [...HEADER_BEFORE, ...(xColumn ? [xColumn] : []), ...HEADER_CHANNEL, ...cols.map((c) => c.column), ...HEADER_AFTER];

/** Encabezado de un CSV sin mediciones: el de una medición sin adquisición (barrido en frecuencia). */
export const defaultCsvHeader = (cols: CsvValueColumn[]): string[] => csvHeader(cols, xColumnOf(parseAcquisitionSnapshot(undefined)));

const metaKey = (name: string, unit: string) => `${name}\u0000${unit}`;

export interface CsvChannel {
  channelNumber: number;
  channelAlias: string | null;
  concreteMix: number | null;
  hasEmulsifier: boolean | null;
  sampleAge: number | null;
  temperature: number | null;
  humidity: number | null;
  notes: string | null;
}

export interface CsvMeasurement {
  id: number;
  takenAt: Date | null;
  takenByName: string | null;
  presetName: string | null;
  watcherStatus: string | null;
  data: unknown;
  /** Snapshot `Measurement.sensorValues` (MeasurementValueMeta[]); se valida con parseSensorValues. */
  sensorValues: unknown;
  /** Snapshot `Measurement.acquisition`; ausente o inválido → barrido en frecuencia (parseAcquisitionSnapshot). */
  acquisition?: unknown;
  channels: CsvChannel[];
}

/**
 * Formato largo: una fila por (x, canal medido); sin celda de x para lecturas puntuales. Solo
 * canales con fila en measurement_channels. Cada columna de `cols` toma el valor del slot del
 * canal si la medición declaró ese (name, unit); si no, queda vacía. Puntos legados
 * ({frequency, g, b}) se ignoran.
 */
export function measurementToRows(m: CsvMeasurement, cols: CsvValueColumn[]): unknown[][] {
  const a = parseAcquisitionSnapshot(m.acquisition);
  const points = storedPointsOf(m.data);
  const declared = new Set(parseSensorValues(m.sensorValues).map((v) => metaKey(v.name, v.unit)));
  const channels = [...m.channels].sort((a, b) => a.channelNumber - b.channelNumber);
  const rows: unknown[][] = [];

  for (const point of points) {
    for (const ch of channels) {
      const idx = ch.channelNumber - 1;
      rows.push([
        m.id,
        m.takenAt ? m.takenAt.toISOString() : '',
        m.takenByName ?? '',
        m.presetName ?? '',
        m.watcherStatus ?? '',
        ...(a.kind === 'sweep' ? [point.x ?? null] : []),
        ch.channelNumber,
        ch.channelAlias ?? '',
        ...cols.map((c) => (declared.has(metaKey(c.name, c.unit)) ? point.values[c.name]?.[idx] ?? null : null)),
        ch.concreteMix,
        ch.hasEmulsifier,
        ch.sampleAge,
        ch.temperature,
        ch.humidity,
        ch.notes,
      ]);
    }
  }
  return rows;
}

/**
 * Preámbulo CSV: BOM (para que Excel lea tildes) + metadatos `# ...`. El encabezado ya no va
 * aquí: depende de la adquisición de cada bloque de mediciones (ver `buildCsv`/`csvHeader`).
 * Cada línea de metadatos se pasa por `toCsvCell` como una sola celda: contiene nombres de
 * proyecto/tarea controlados por el usuario, así que comas/comillas se citan (RFC 4180) y no
 * se "parten" en columnas que Excel podría evaluar como fórmula (CSV injection).
 */
export function csvPreamble(metaLines: string[]): string {
  const lines = metaLines.map((l) => toCsvCell(`# ${l.replace(/[\r\n]+/g, ' ')}`));
  return '﻿' + lines.join('\r\n');
}

/** Líneas CSV (sin BOM ni encabezado) para una medición; una por (x, canal medido). */
export function rowsToCsvLines(m: CsvMeasurement, cols: CsvValueColumn[]): string[] {
  return measurementToRows(m, cols).map(toCsvRow);
}

/**
 * CSV completo: preámbulo + un bloque (con su propio encabezado) por cada tramo consecutivo de
 * mediciones con la misma adquisición (mismo `blockKeyOf`). Las columnas de valor son la unión de
 * los sensorValues declarados, calculada una sola vez para todas las mediciones.
 */
export function buildCsv(metaLines: string[], measurements: CsvMeasurement[]): string {
  const cols = valueColumnsFor(measurements.flatMap((m) => parseSensorValues(m.sensorValues)));
  const lines = [csvPreamble(metaLines)];
  let prevKey: string | null = null;
  for (const m of measurements) {
    const a = parseAcquisitionSnapshot(m.acquisition);
    const key = blockKeyOf(a);
    if (key !== prevKey) {
      lines.push(csvHeader(cols, xColumnOf(a)).join(','));
      prevKey = key;
    }
    lines.push(...rowsToCsvLines(m, cols));
  }
  if (measurements.length === 0) lines.push(defaultCsvHeader(cols).join(','));
  return lines.join('\r\n');
}
