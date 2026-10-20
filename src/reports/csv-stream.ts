import { once } from 'node:events';
import type { Response } from 'express';

export interface StreamableRow {
  id: number;
}

/** Trae la siguiente página a partir de `cursor` (id de la última fila de la página anterior, o `null` para la primera). */
export type FetchPage<T> = (cursor: number | null) => Promise<T[]>;

/** Escribe un fragmento y espera su resolución (p. ej. a que el socket drene) antes de continuar. */
export type WriteChunk = (chunk: string) => Promise<void>;

/** `true` si el cliente cortó la descarga; el bucle corta sin más consultas. */
export type IsAborted = () => boolean;

/**
 * Pagina mediciones con cursor estable (sin `skip` por offset: evita saltos/duplicados si se
 * insertan o eliminan filas entre páginas) y escribe cada fila como CSV, esperando backpressure
 * (`writeChunk`) y cortando temprano si el cliente abortó (`isAborted`). No atrapa errores de
 * `fetchPage`/`writeChunk`: se propagan al llamador, que decide cómo fallar visiblemente.
 */
export async function streamMeasurementsCsv<T extends StreamableRow>(
  fetchPage: FetchPage<T>,
  writeChunk: WriteChunk,
  isAborted: IsAborted,
  toLines: (row: T) => string[],
): Promise<void> {
  let cursor: number | null = null;
  for (;;) {
    if (isAborted()) return;

    const rows = await fetchPage(cursor);
    if (rows.length === 0) return;

    for (const row of rows) {
      const lines = toLines(row);
      if (lines.length) await writeChunk('\r\n' + lines.join('\r\n'));
    }

    cursor = rows[rows.length - 1].id;
  }
}

/**
 * `res.write` con backpressure: si el buffer interno está lleno, espera a `drain` (listo para
 * seguir escribiendo) o `close` (el cliente cortó la conexión), lo que ocurra primero, para no
 * quedar colgado esperando un `drain` que ya no llegará.
 */
export async function writeChunk(res: Response, chunk: string): Promise<void> {
  if (res.write(chunk)) return;
  await Promise.race([once(res, 'drain'), once(res, 'close')]);
}
