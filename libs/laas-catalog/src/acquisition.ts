import type { DeviceServiceDescription } from './contract';

/**
 * Adquisición declarada por cada sensor (extensión Kronos sobre la Tabla 14 de IEEE 1876):
 * cómo produce sus sensorValues. El núcleo no conoce "frecuencia": la variable del barrido se declara.
 */
export type SweepScale = 'LIN' | 'LOG';
export const SWEEP_SCALES: readonly SweepScale[] = ['LIN', 'LOG'];

export interface SweepVariable { name: string; unit: string; label: string; rangeMinimum: number; rangeMaximum: number }
export interface SweepAcquisition {
  kind: 'sweep';
  variable: SweepVariable;
  points: { minimum: number; maximum: number };
  scales: SweepScale[];
  secondsPerPoint: number;
}
export interface SingleAcquisition { kind: 'single'; secondsPerReading: number }
export type AcquisitionMetadata = SweepAcquisition | SingleAcquisition;

export type AcquisitionRequest =
  | { kind: 'sweep'; start: number; stop: number; points: number; scale: SweepScale }
  | { kind: 'single' };

/** Un rango de barrido tal como lo guarda una configuración de tarea. */
export interface SweepRange { start: number; stop: number; points: number; scale: string }

/** Copia que guarda cada medición: tipo y variable (sin límites). */
export type AcquisitionSnapshot =
  | { kind: 'sweep'; variable: { name: string; unit: string; label: string } }
  | { kind: 'single' };

/** Cambio de canal en el selector (HTTP + asentamiento) y comandos de setup por rango de barrido. */
export const CHANNEL_SWITCH_SECONDS = 1.5;
export const RANGE_SETUP_SECONDS = 1;

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

function fail(path: string, problem: string): never {
  throw new Error(`${path}: ${problem}`);
}
function obj(path: string, v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'debe ser un objeto');
  return v as Record<string, unknown>;
}
function num(path: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'debe ser un número');
  return v;
}
function positive(path: string, v: unknown): number {
  const n = num(path, v);
  if (n <= 0) fail(path, 'debe ser mayor que 0');
  return n;
}
function text(path: string, v: unknown): string {
  if (typeof v !== 'string') fail(path, 'debe ser un texto');
  return v;
}

export function parseAcquisition(path: string, v: unknown): AcquisitionMetadata {
  const o = obj(path, v);
  if (o.kind === 'single') return { kind: 'single', secondsPerReading: positive(`${path}.secondsPerReading`, o.secondsPerReading) };
  if (o.kind !== 'sweep') fail(`${path}.kind`, 'debe ser uno de: sweep, single');

  const vo = obj(`${path}.variable`, o.variable);
  const name = text(`${path}.variable.name`, vo.name);
  if (!NAME_PATTERN.test(name)) fail(`${path}.variable.name`, 'debe cumplir ^[a-z][a-z0-9_]*$ (se usa como columna CSV)');
  const variable: SweepVariable = {
    name,
    unit: text(`${path}.variable.unit`, vo.unit),
    label: text(`${path}.variable.label`, vo.label),
    rangeMinimum: num(`${path}.variable.rangeMinimum`, vo.rangeMinimum),
    rangeMaximum: num(`${path}.variable.rangeMaximum`, vo.rangeMaximum),
  };
  if (variable.rangeMinimum >= variable.rangeMaximum) fail(`${path}.variable`, 'rangeMinimum debe ser menor que rangeMaximum');

  const po = obj(`${path}.points`, o.points);
  const minimum = num(`${path}.points.minimum`, po.minimum);
  const maximum = num(`${path}.points.maximum`, po.maximum);
  if (!Number.isInteger(minimum) || minimum < 1) fail(`${path}.points.minimum`, 'debe ser un entero ≥ 1');
  if (!Number.isInteger(maximum) || maximum < minimum) fail(`${path}.points`, 'maximum debe ser un entero ≥ minimum');

  if (!Array.isArray(o.scales) || o.scales.length === 0) fail(`${path}.scales`, 'debe declarar al menos una escala');
  for (const s of o.scales) {
    if (!(SWEEP_SCALES as readonly unknown[]).includes(s)) fail(`${path}.scales`, `debe contener solo: ${SWEEP_SCALES.join(', ')}`);
  }

  return {
    kind: 'sweep',
    variable,
    points: { minimum, maximum },
    scales: [...new Set(o.scales as SweepScale[])],
    secondsPerPoint: positive(`${path}.secondsPerPoint`, o.secondsPerPoint),
  };
}

/** Adquisición de un dispositivo: la de su primer sensor (todos comparten tipo, ver parseServiceDescription). */
export function acquisitionOf(d: DeviceServiceDescription): AcquisitionMetadata | null {
  return d.sensors[0]?.acquisition ?? null;
}

export function snapshotOf(a: AcquisitionMetadata): AcquisitionSnapshot {
  if (a.kind === 'single') return { kind: 'single' };
  const { name, unit, label } = a.variable;
  return { kind: 'sweep', variable: { name, unit, label } };
}

const SI_PREFIXES: Array<[number, string]> = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']];

/** 9000 Hz → "9 kHz", 3e9 Hz → "3 GHz"; sin prefijo por debajo de 1000. */
export function formatSi(value: number, unit: string): string {
  const abs = Math.abs(value);
  for (const [factor, prefix] of SI_PREFIXES) {
    if (abs >= factor) return `${+(value / factor).toPrecision(4)} ${prefix}${unit}`;
  }
  return `${+value.toPrecision(4)} ${unit}`;
}

/** Valores de la variable de un barrido; LOG exige start > 0 (si no, lineal). */
export function sweepXs(start: number, stop: number, points: number, scale: string): number[] {
  if (points <= 1) return [start];
  return Array.from({ length: points }, (_, i) => {
    const t = i / (points - 1);
    return scale === 'LOG' && start > 0 ? +(start * (stop / start) ** t).toPrecision(12) : start + (stop - start) * t;
  });
}

/** Primer error de los rangos frente a la adquisición declarada por el sensor, o null. */
export function rangesError(a: AcquisitionMetadata, ranges: SweepRange[], shortName: string): string | null {
  if (a.kind === 'single') {
    return ranges.length > 0 ? `${shortName} toma lecturas puntuales; no admite rangos de barrido` : null;
  }
  if (ranges.length === 0) return 'Indica al menos un rango de barrido';
  const v = a.variable;
  for (const r of ranges) {
    if (r.start < v.rangeMinimum || r.stop > v.rangeMaximum) {
      return `${shortName} mide ${v.label} entre ${formatSi(v.rangeMinimum, v.unit)} y ${formatSi(v.rangeMaximum, v.unit)}`;
    }
    if (r.points < a.points.minimum || r.points > a.points.maximum) {
      return a.points.minimum === a.points.maximum
        ? `${shortName} usa siempre ${a.points.minimum} puntos`
        : `${shortName} admite entre ${a.points.minimum} y ${a.points.maximum} puntos`;
    }
    if (!(a.scales as string[]).includes(r.scale)) {
      return `${shortName} no admite escala ${r.scale} (permitidas: ${a.scales.join(', ')})`;
    }
  }
  return null;
}

/** Peticiones getSensorData de una ejecución: una por rango (sweep) o una lectura (single). */
export function requestsFor(a: AcquisitionMetadata, ranges: SweepRange[]): AcquisitionRequest[] {
  if (a.kind === 'single') return [{ kind: 'single' }];
  return ranges.map((r) => ({ kind: 'sweep', start: r.start, stop: r.stop, points: r.points, scale: r.scale as SweepScale }));
}

/** canales × [cambio de canal (si hay selector) + Σ rangos(setup + puntos·t)] o × [cambio + lectura]. */
export function estimateAcquisitionSeconds(
  a: AcquisitionMetadata,
  ranges: { points: number }[],
  channelCount: number,
  hasSelector: boolean,
): number {
  const switching = hasSelector ? CHANNEL_SWITCH_SECONDS : 0;
  const perChannel = a.kind === 'single'
    ? switching + a.secondsPerReading
    : switching + ranges.reduce((sum, r) => sum + RANGE_SETUP_SECONDS + r.points * a.secondsPerPoint, 0);
  return Math.ceil(channelCount * perChannel);
}
