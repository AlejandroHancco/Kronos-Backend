/**
 * Aritmética pura de series de medición programadas (todo en ms epoch UTC).
 * La ocurrencia `executionIndex` (1-based) empieza en
 * `seriesStartAt + (executionIndex − 1) × intervalMinutes` y ocupa el intervalo semiabierto
 * `[inicio, inicio + reservedSeconds)`: extremos que se tocan no se solapan.
 * `intervalMinutes` null ⇒ serie única: solo cuenta `firstIndex` (firstIndex === lastIndex).
 */
export interface SeriesWindow {
  seriesStartAt: Date;
  intervalMinutes: number | null;
  firstIndex: number;
  lastIndex: number;
  reservedSeconds: number;
}

const MS_PER_MIN = 60_000;

/** Serie normalizada: ocurrencias locales k = 0..count-1 en `start + k·period`. */
interface Norm {
  start: number;
  period: number;
  count: number;
  reserved: number;
  firstIndex: number;
}

function normalize(s: SeriesWindow): Norm {
  const reserved = s.reservedSeconds * 1000;
  if (s.intervalMinutes == null) {
    return { start: s.seriesStartAt.getTime(), period: 0, count: 1, reserved, firstIndex: s.firstIndex };
  }
  const period = s.intervalMinutes * MS_PER_MIN;
  return {
    start: s.seriesStartAt.getTime() + (s.firstIndex - 1) * period,
    period,
    count: Math.max(0, s.lastIndex - s.firstIndex + 1),
    reserved,
    firstIndex: s.firstIndex,
  };
}

/** Rango [lo, hi] de k locales cuyo inicio cae estrictamente dentro de (lowerExcl, upperExcl). */
function startsWithin(n: Norm, lowerExcl: number, upperExcl: number): [number, number] {
  if (n.count === 1 || n.period === 0) {
    return n.start > lowerExcl && n.start < upperExcl ? [0, 0] : [1, 0];
  }
  const lo = Math.max(0, Math.floor((lowerExcl - n.start) / n.period) + 1);
  const hi = Math.min(n.count - 1, Math.ceil((upperExcl - n.start) / n.period) - 1);
  return [lo, hi];
}

export function occurrenceStart(
  s: Pick<SeriesWindow, 'seriesStartAt' | 'intervalMinutes'>,
  executionIndex: number,
): Date {
  if (s.intervalMinutes == null) return new Date(s.seriesStartAt.getTime());
  return new Date(s.seriesStartAt.getTime() + (executionIndex - 1) * s.intervalMinutes * MS_PER_MIN);
}

/**
 * Primer par de ocurrencias (por instante de inicio del solapamiento) que se solapan, o null.
 * O(min(n, m)): recorre la serie con menos ocurrencias, solo dentro del tramo común, y calcula
 * por división el rango candidato de la otra.
 */
export function firstOverlap(
  a: SeriesWindow,
  b: SeriesWindow,
): { aIndex: number; bIndex: number; at: Date } | null {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.count === 0 || nb.count === 0) return null;
  const swap = nb.count < na.count;
  const outer = swap ? nb : na;
  const inner = swap ? na : nb;

  const innerEnd = inner.start + (inner.count - 1) * inner.period;
  // ocurrencias de outer que pueden tocar el tramo de inner: t + Ro > innerStart y t < innerEnd + Ri
  const [klo, khi] = startsWithin(outer, inner.start - outer.reserved, innerEnd + inner.reserved);
  for (let k = klo; k <= khi; k++) {
    const t = outer.start + k * outer.period;
    // inner j se solapa con [t, t + Ro) ⇔ t − Ri < s_j < t + Ro
    const [jlo, jhi] = startsWithin(inner, t - inner.reserved, t + outer.reserved);
    if (jlo <= jhi) {
      const sj = inner.start + jlo * inner.period;
      const outerIndex = outer.firstIndex + k;
      const innerIndex = inner.firstIndex + jlo;
      return {
        aIndex: swap ? innerIndex : outerIndex,
        bIndex: swap ? outerIndex : innerIndex,
        at: new Date(Math.max(t, sj)),
      };
    }
  }
  return null;
}

/** true si la serie tiene más de una ocurrencia y el intervalo es menor que la reserva. */
export function selfOverlaps(s: SeriesWindow): boolean {
  if (s.intervalMinutes == null || s.lastIndex <= s.firstIndex) return false;
  return s.intervalMinutes * 60 < s.reservedSeconds;
}

/** Inicio de ocurrencia más temprano estrictamente posterior a `after`, entre todas las series. */
export function nextReservationStart(series: SeriesWindow[], after: Date): Date | null {
  const afterMs = after.getTime();
  let best: number | null = null;
  for (const s of series) {
    const n = normalize(s);
    if (n.count === 0) continue;
    const [lo, hi] = startsWithin(n, afterMs, Infinity);
    if (lo > hi) continue;
    const start = n.start + lo * n.period;
    if (best === null || start < best) best = start;
  }
  return best === null ? null : new Date(best);
}

/**
 * Inicio de la ocurrencia en curso (inicio ≤ now < inicio + reserva) o que empieza a lo sumo `leadSeconds`
 * después de `now`; la más temprana entre todas las series, o null.
 */
export function reservationNear(series: SeriesWindow[], now: Date, leadSeconds: number): Date | null {
  const nowMs = now.getTime();
  let best: number | null = null;
  for (const s of series) {
    const n = normalize(s);
    if (n.count === 0) continue;
    // inicios en (now − reserva, now + lead] (cota superior exclusiva +1 ms)
    const [lo, hi] = startsWithin(n, nowMs - n.reserved, nowMs + leadSeconds * 1000 + 1);
    if (lo > hi) continue;
    const start = n.start + lo * n.period;
    if (best === null || start < best) best = start;
  }
  return best === null ? null : new Date(best);
}

/** HH:MM en hora local de Lima (para mensajes al usuario). */
export function limaTime(date: Date): string {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).format(date);
}

/** ceil(max(estimación, ...reales) × 1.2), al menos estimación + 60 s. */
export function reservedSecondsFor(estimateSeconds: number, actualDurationsSeconds: number[]): number {
  const max = Math.max(estimateSeconds, ...actualDurationsSeconds);
  // ×12/10 evita el error de coma flotante de ×1.2 con enteros (150 × 1.2 → 180, no 180.00…01)
  return Math.max(Math.ceil((max * 12) / 10), estimateSeconds + 60);
}

/**
 * Primer inicio ≥ `from` (en pasos de `stepMinutes`, hasta `from + horizonHours` inclusive) en el
 * que la serie candidata no se solapa con ninguna de `others` ni consigo misma; null si no hay.
 *
 * Salto (jump-ahead): si la ocurrencia `aIndex` del candidato (inicio ta) choca con la ocurrencia
 * `bIndex` de otra serie (inicio tb, reserva Rb), todo desplazamiento d < tb + Rb − ta sigue
 * chocando con ese mismo par (ta + d sigue dentro de [ta, tb + Rb) y ta + Ra > tb). Así que se
 * avanza al primer paso ≥ ese desplazamiento en vez de probar paso a paso; mismo resultado que
 * la búsqueda ingenua.
 */
export function suggestStart(
  candidate: Omit<SeriesWindow, 'seriesStartAt'>,
  others: SeriesWindow[],
  from: Date,
  stepMinutes = 1,
  horizonHours = 24,
): Date | null {
  if (!(stepMinutes > 0)) throw new RangeError('stepMinutes must be > 0');
  if (selfOverlaps({ ...candidate, seriesStartAt: from })) return null;
  const fromMs = from.getTime();
  const stepMs = stepMinutes * MS_PER_MIN;
  const steps = Math.floor((horizonHours * 60 * MS_PER_MIN) / stepMs);
  let i = 0;
  while (i <= steps) {
    const startMs = fromMs + i * stepMs;
    const c: SeriesWindow = { ...candidate, seriesStartAt: new Date(startMs) };
    let clearFromMs = startMs; // primer inicio que podría estar libre de todos los choques vistos
    for (const o of others) {
      const hit = firstOverlap(c, o);
      if (!hit) continue;
      const ta = occurrenceStart(c, hit.aIndex).getTime();
      const tbEnd = occurrenceStart(o, hit.bIndex).getTime() + o.reservedSeconds * 1000;
      clearFromMs = Math.max(clearFromMs, startMs + (tbEnd - ta));
    }
    if (clearFromMs === startMs) return c.seriesStartAt;
    i = Math.max(i + 1, Math.ceil((clearFromMs - fromMs) / stepMs));
  }
  return null;
}
