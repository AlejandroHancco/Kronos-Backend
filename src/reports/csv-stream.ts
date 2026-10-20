import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/** Clave de orden de una fila: (`takenAt` ASC NULLS FIRST, `id` ASC). */
export interface StreamableRow {
  id: number;
  takenAt: Date | null;
  /** Valor exacto de `takenAt` (µs) como texto, si la fuente lo provee (ver `pageIdsQuery`). */
  takenAtKey?: string | null;
}

/** Clave de la última fila entregada, o `null` para la primera página. */
export type PageCursor = { id: number; takenAt: Date | null; takenAtKey?: string | null } | null;

/** Trae la siguiente página estrictamente posterior a `cursor` en el orden (takenAt NULLS FIRST, id). */
export type FetchPage<T> = (cursor: PageCursor) => Promise<T[]>;

/** Escribe un fragmento y espera su resolución (p. ej. a que el socket drene) antes de continuar. */
export type WriteChunk = (chunk: string) => Promise<void>;

/** `true` si el cliente cortó la descarga; el bucle corta sin más consultas. */
export type IsAborted = () => boolean;

/** Filtro de tarea/rango; equivalente a `{ taskId, ...takenAtWhere(range) }` (gte/lte inclusivos). */
export interface PageFilter {
  taskId: number;
  from: Date | null;
  to: Date | null;
}

/**
 * Cursor keyset con el valor EXACTO almacenado de `takenAt` (TIMESTAMPTZ(6), microsegundos)
 * como texto ISO-8601 UTC, tal como lo devuelve `pageIdsQuery`. `takenAtKey === null` = la
 * fila cursor tenía `takenAt` NULL.
 */
export type SqlCursor = { id: number; takenAtKey: string | null } | null;

/**
 * Convierte el cursor del stream al de SQL. Exige `takenAtKey` cuando `takenAt` no es NULL:
 * caer al `Date` (ms) reintroduciría el bug de precisión.
 */
export function toSqlCursor(cursor: PageCursor): SqlCursor {
  if (cursor === null) return null;
  if (cursor.takenAt === null) return { id: cursor.id, takenAtKey: null };
  if (!cursor.takenAtKey) throw new Error(`CSV cursor ${cursor.id} lacks exact takenAt key`);
  return { id: cursor.id, takenAtKey: cursor.takenAtKey };
}

/** Fila que devuelve `pageIdsQuery`. */
export interface PageIdRow {
  id: number;
  takenAtKey: string | null;
}

/**
 * SQL de la siguiente página de ids en el orden `takenAt ASC NULLS FIRST, id ASC`, estrictamente
 * después de `cursor`. La comparación se hace en SQL contra el valor almacenado (no contra un
 * `Date` de JS, que trunca a milisegundos y haría re-incluir o saltar filas con microsegundos).
 * El cursor lleva el timestamp como texto con microsegundos (no una subconsulta por id), así una
 * fila cursor borrada entre páginas no corta la descarga en silencio. Todo va parametrizado.
 */
export function pageIdsQuery(filter: PageFilter, cursor: SqlCursor, batchSize: number): Prisma.Sql {
  const conds: Prisma.Sql[] = [Prisma.sql`m."taskId" = ${filter.taskId}`];
  // Igual que `takenAt: { gte, lte }` de Prisma: con rango, las filas NULL quedan fuera.
  if (filter.from) conds.push(Prisma.sql`m."takenAt" >= ${filter.from.toISOString()}::timestamptz`);
  if (filter.to) conds.push(Prisma.sql`m."takenAt" <= ${filter.to.toISOString()}::timestamptz`);
  if (cursor !== null) {
    if (cursor.takenAtKey === null) {
      // Aún dentro del bloque de NULLs: resto de NULLs con id mayor, luego todas las no nulas.
      conds.push(Prisma.sql`((m."takenAt" IS NULL AND m.id > ${cursor.id}) OR m."takenAt" IS NOT NULL)`);
    } else {
      // Pasado el bloque de NULLs: nunca vuelven a entrar. Comparación de row-values exacta.
      conds.push(
        Prisma.sql`m."takenAt" IS NOT NULL AND (m."takenAt", m.id) > (${cursor.takenAtKey}::timestamptz, ${cursor.id})`,
      );
    }
  }
  return Prisma.sql`SELECT m.id,
      to_char(m."takenAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "takenAtKey"
    FROM platform.measurements m
    WHERE ${Prisma.join(conds, ' AND ')}
    ORDER BY m."takenAt" ASC NULLS FIRST, m.id ASC
    LIMIT ${batchSize}`;
}

/** Reordena `rows` según `ids` (el orden que fijó la consulta SQL); omite ids ya inexistentes. */
export function orderByIds<T extends { id: number }>(ids: number[], rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [r] : [];
  });
}

/**
 * Una página keyset en dos pasos: ids ordenados en SQL (`queryIds`) y luego las filas por id
 * (`loadRows`), reordenadas y con `takenAtKey` exacto adjunto. Si alguna fila desaparece entre
 * ambos pasos (borrado concurrente), completa la página desde el último id de SQL, para que una
 * página corta siga significando "no hay más" y el stream no termine antes de tiempo.
 */
export async function fetchKeysetPage<T extends { id: number }>(
  queryIds: (cursor: SqlCursor, limit: number) => Promise<PageIdRow[]>,
  loadRows: (ids: number[]) => Promise<T[]>,
  cursor: PageCursor,
  batchSize: number,
): Promise<Array<T & { takenAtKey: string | null }>> {
  const out: Array<T & { takenAtKey: string | null }> = [];
  let sqlCursor = toSqlCursor(cursor);
  for (;;) {
    const need = batchSize - out.length;
    const page = await queryIds(sqlCursor, need);
    if (page.length === 0) return out;
    const keys = new Map(page.map((p) => [p.id, p.takenAtKey]));
    const ids = page.map((p) => p.id);
    for (const r of orderByIds(ids, await loadRows(ids))) out.push({ ...r, takenAtKey: keys.get(r.id) ?? null });
    if (page.length < need || out.length >= batchSize) return out;
    const last = page[page.length - 1];
    sqlCursor = { id: last.id, takenAtKey: last.takenAtKey };
  }
}

/** Compara claves en el orden (takenAt NULLS FIRST, id). Negativo si a va antes que b. */
export function compareKeys(a: NonNullable<PageCursor>, b: NonNullable<PageCursor>): number {
  if (a.takenAt === null && b.takenAt !== null) return -1;
  if (a.takenAt !== null && b.takenAt === null) return 1;
  if (a.takenAt !== null && b.takenAt !== null) {
    const d = a.takenAt.getTime() - b.takenAt.getTime();
    if (d !== 0) return d;
  }
  return a.id - b.id;
}

/**
 * `true` si la página no avanzó respecto de `cursor`: vuelve a traer la fila cursor, o su
 * `takenAt` (en ms, la precisión de `Date`) retrocede. No se compara el id dentro del mismo
 * milisegundo: dos filas del mismo ms con distinto microsegundo pueden ir con ids decrecientes.
 */
function didNotAdvance(rows: StreamableRow[], cursor: NonNullable<PageCursor>): boolean {
  if (rows.some((r) => r.id === cursor.id)) return true;
  const next = rows[rows.length - 1].takenAt;
  if (cursor.takenAt === null) return false;
  return next === null || next.getTime() < cursor.takenAt.getTime();
}

/**
 * Pagina mediciones por keyset (sin `skip` por offset: evita saltos/duplicados si se insertan o
 * eliminan filas entre páginas) y escribe cada fila como CSV, esperando backpressure
 * (`writeChunk`) y cortando temprano si el cliente abortó (`isAborted`, revisado por fila).
 * Termina cuando una página trae menos de `batchSize` filas. Lanza si la página no avanza
 * (guarda contra bucles infinitos). No atrapa errores de `fetchPage`/`writeChunk`: se propagan
 * al llamador, que decide cómo fallar visiblemente.
 */
export async function streamMeasurementsCsv<T extends StreamableRow>(
  fetchPage: FetchPage<T>,
  writeChunk: WriteChunk,
  isAborted: IsAborted,
  toLines: (row: T) => string[],
  batchSize: number,
): Promise<void> {
  let cursor: PageCursor = null;
  for (;;) {
    if (isAborted()) return;

    const rows = await fetchPage(cursor);
    if (rows.length === 0) return;

    for (const row of rows) {
      if (isAborted()) return;
      const lines = toLines(row);
      if (lines.length) await writeChunk('\r\n' + lines.join('\r\n'));
    }

    const last = rows[rows.length - 1];
    if (cursor !== null && didNotAdvance(rows, cursor)) {
      throw new Error(`CSV paging did not advance (id ${cursor.id} -> ${last.id})`);
    }
    cursor = {
      id: last.id,
      takenAt: last.takenAt,
      ...(last.takenAtKey !== undefined ? { takenAtKey: last.takenAtKey } : {}),
    };

    if (rows.length < batchSize) return;
  }
}

/** Parte de `res` que usa writeChunk. */
type WritableRes = Pick<Response, 'write' | 'on' | 'off' | 'destroyed' | 'writableEnded'>;

const isGone = (res: WritableRes) => res.destroyed || res.writableEnded;

/**
 * Espera el primero de `drain`/`close`/`error` y quita los tres listeners al resolverse, para no
 * acumularlos entre ciclos de backpressure.
 */
function waitWritable(res: WritableRes): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
    res.on('error', done);
  });
}

/**
 * `res.write` con backpressure: si el buffer interno está lleno, espera a `drain` (listo para
 * seguir), `close` (el cliente cortó) o `error`, lo que ocurra primero. Si la respuesta ya está
 * cerrada/destruida no escribe ni espera: un `close` ya emitido no se repite y la espera colgaría.
 */
export async function writeChunk(res: WritableRes, chunk: string): Promise<void> {
  if (isGone(res)) return;
  if (res.write(chunk)) return;
  if (isGone(res)) return;
  await waitWritable(res);
}
