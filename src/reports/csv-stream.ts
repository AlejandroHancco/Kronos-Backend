import type { Prisma } from '@prisma/client';
import type { Response } from 'express';

/** Clave de orden de una fila: (`takenAt` ASC NULLS FIRST, `id` ASC). */
export interface StreamableRow {
  id: number;
  takenAt: Date | null;
}

/** Clave de la última fila entregada, o `null` para la primera página. */
export type PageCursor = { id: number; takenAt: Date | null } | null;

/** Trae la siguiente página estrictamente posterior a `cursor` en el orden (takenAt NULLS FIRST, id). */
export type FetchPage<T> = (cursor: PageCursor) => Promise<T[]>;

/** Escribe un fragmento y espera su resolución (p. ej. a que el socket drene) antes de continuar. */
export type WriteChunk = (chunk: string) => Promise<void>;

/** `true` si el cliente cortó la descarga; el bucle corta sin más consultas. */
export type IsAborted = () => boolean;

/**
 * Predicado keyset "estrictamente después de `cursor`" para el orden
 * `takenAt ASC NULLS FIRST, id ASC`. Se usa en lugar del `cursor` de Prisma porque éste, sobre
 * una columna nullable, genera un predicado que vuelve a incluir las filas con `takenAt = NULL`
 * (duplicados y bucle infinito). Se combina con `AND` al filtro de tarea/rango.
 */
export function keysetAfter(cursor: PageCursor): Prisma.MeasurementWhereInput {
  if (cursor === null) return {};
  if (cursor.takenAt === null) {
    // Aún dentro del bloque de NULLs: resto de NULLs con id mayor, luego todas las no nulas.
    return { OR: [{ takenAt: null, id: { gt: cursor.id } }, { takenAt: { not: null } }] };
  }
  // Pasado el bloque de NULLs: nunca vuelven a entrar (ni `gt` ni la igualdad matchean NULL).
  return {
    OR: [{ takenAt: { gt: cursor.takenAt } }, { takenAt: cursor.takenAt, id: { gt: cursor.id } }],
  };
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
 * Pagina mediciones por keyset (sin `skip` por offset: evita saltos/duplicados si se insertan o
 * eliminan filas entre páginas) y escribe cada fila como CSV, esperando backpressure
 * (`writeChunk`) y cortando temprano si el cliente abortó (`isAborted`, revisado por fila).
 * Termina cuando una página trae menos de `batchSize` filas. Lanza si la clave no avanza
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
    const next = { id: last.id, takenAt: last.takenAt };
    if (cursor !== null && compareKeys(next, cursor) <= 0) {
      throw new Error(`CSV paging did not advance (id ${cursor.id} -> ${next.id})`);
    }
    cursor = next;

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
