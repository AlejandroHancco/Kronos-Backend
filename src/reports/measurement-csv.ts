import { toCsvCell, toCsvRow } from './csv.util';
import { parseSensorValues, storedPointsOf, type MeasurementValueMeta } from '../measurements/measurement-data';

const HEADER_BEFORE = ['measurement_id', 'taken_at', 'taken_by', 'preset', 'watcher_status', 'frequency_hz', 'channel', 'channel_alias'];
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

export const csvHeader = (cols: CsvValueColumn[]): string[] =>
  [...HEADER_BEFORE, ...cols.map((c) => c.column), ...HEADER_AFTER];

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
  channels: CsvChannel[];
}

/**
 * Formato largo: una fila por (frecuencia, canal medido). Solo canales con fila en
 * measurement_channels. Cada columna de `cols` toma el valor del slot del canal si la medición
 * declaró ese (name, unit); si no, queda vacía. Puntos legados ({frequency, g, b}) se ignoran.
 */
export function measurementToRows(m: CsvMeasurement, cols: CsvValueColumn[]): unknown[][] {
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
        point.frequency,
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
 * Preámbulo CSV: BOM (para que Excel lea tildes) + metadatos `# ...` + encabezado.
 * Cada línea de metadatos se pasa por `toCsvCell` como una sola celda: contiene nombres de
 * proyecto/tarea controlados por el usuario, así que comas/comillas se citan (RFC 4180) y no
 * se "parten" en columnas que Excel podría evaluar como fórmula (CSV injection).
 */
export function csvPreamble(metaLines: string[], cols: CsvValueColumn[]): string {
  const lines = [
    ...metaLines.map((l) => toCsvCell(`# ${l.replace(/[\r\n]+/g, ' ')}`)),
    csvHeader(cols).join(','),
  ];
  return '﻿' + lines.join('\r\n');
}

/** Líneas CSV (sin BOM ni encabezado) para una medición; una por (frecuencia, canal medido). */
export function rowsToCsvLines(m: CsvMeasurement, cols: CsvValueColumn[]): string[] {
  return measurementToRows(m, cols).map(toCsvRow);
}

/** CSV completo: preámbulo + filas; las columnas de valor son la unión de los sensorValues declarados. */
export function buildCsv(metaLines: string[], measurements: CsvMeasurement[]): string {
  const cols = valueColumnsFor(measurements.flatMap((m) => parseSensorValues(m.sensorValues)));
  const lines = [csvPreamble(metaLines, cols), ...measurements.flatMap((m) => rowsToCsvLines(m, cols))];
  return lines.join('\r\n');
}
