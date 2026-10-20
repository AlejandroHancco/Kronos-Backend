import { EventEmitter } from 'node:events';
import {
  compareKeys,
  fetchKeysetPage,
  orderByIds,
  PageCursor,
  PageIdRow,
  pageIdsQuery,
  SqlCursor,
  streamMeasurementsCsv,
  toSqlCursor,
  writeChunk,
  StreamableRow,
} from './csv-stream';

interface Row extends StreamableRow {
  label: string;
}

const row = (id: number, takenAt: string | null = null): Row => ({
  id,
  takenAt: takenAt === null ? null : new Date(takenAt),
  label: String.fromCharCode(96 + id),
});

/** Fila "de base de datos" con timestamp exacto en µs (texto ISO UTC de ancho fijo). */
interface DbRow { id: number; key: string | null }

/** Orden SQL (takenAt NULLS FIRST, id) sobre el valor exacto (µs); el ISO de ancho fijo ordena léxicamente. */
const dbCompare = (a: DbRow, b: DbRow) => {
  if (a.key === null && b.key !== null) return -1;
  if (a.key !== null && b.key === null) return 1;
  if (a.key !== null && b.key !== null && a.key !== b.key) return a.key < b.key ? -1 : 1;
  return a.id - b.id;
};

/** Simula `pageIdsQuery` (row-value > cursor sobre el valor exacto) + `findMany` por ids. */
function simulatedDb(table: DbRow[]) {
  const sorted = [...table].sort(dbCompare);
  const queryIds = jest.fn(async (cursor: SqlCursor, limit: number): Promise<PageIdRow[]> =>
    sorted
      .filter((r) => cursor === null || dbCompare(r, { id: cursor.id, key: cursor.takenAtKey }) > 0)
      .slice(0, limit)
      .map((r) => ({ id: r.id, takenAtKey: r.key })),
  );
  // `Date` trunca a ms, como Prisma; el orden de `findMany({ id: { in } })` no está garantizado.
  const loadRows = jest.fn(async (ids: number[]): Promise<StreamableRow[]> =>
    table
      .filter((r) => ids.includes(r.id))
      .reverse()
      .map((r) => ({ id: r.id, takenAt: r.key === null ? null : new Date(r.key) })),
  );
  return { queryIds, loadRows };
}

describe('pageIdsQuery', () => {
  const filter = { taskId: 1, from: null, to: null };

  it('primera página: sólo tarea, orden NULLS FIRST, LIMIT parametrizado', () => {
    const q = pageIdsQuery(filter, null, 10);
    expect(q.text).toContain('m."taskId" = $1');
    expect(q.text).toContain('ORDER BY m."takenAt" ASC NULLS FIRST, m.id ASC');
    expect(q.text).toContain('LIMIT $2');
    expect(q.text).not.toContain('IS NULL');
    expect(q.values).toEqual([1, 10]);
  });

  it('rango: gte/lte inclusivos como texto ISO casteado a timestamptz', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-31T23:59:59.999Z');
    const q = pageIdsQuery({ taskId: 7, from, to }, null, 5);
    expect(q.text).toContain('m."takenAt" >= $2::timestamptz');
    expect(q.text).toContain('m."takenAt" <= $3::timestamptz');
    expect(q.values).toEqual([7, from.toISOString(), to.toISOString(), 5]);
    expect(pageIdsQuery({ taskId: 7, from, to: null }, null, 5).values).toEqual([7, from.toISOString(), 5]);
  });

  it('cursor en el bloque NULL: NULLs con id mayor o cualquier no nula', () => {
    const q = pageIdsQuery(filter, { id: 9, takenAtKey: null }, 10);
    expect(q.text).toContain('((m."takenAt" IS NULL AND m.id > $2) OR m."takenAt" IS NOT NULL)');
    expect(q.values).toEqual([1, 9, 10]);
  });

  it('cursor no nulo: row-value contra el timestamp exacto (µs), sin Date', () => {
    const key = '2026-01-01T00:00:00.000123Z';
    const q = pageIdsQuery(filter, { id: 9, takenAtKey: key }, 10);
    expect(q.text).toContain('m."takenAt" IS NOT NULL AND (m."takenAt", m.id) > ($2::timestamptz, $3)');
    expect(q.values).toEqual([1, key, 9, 10]);
    expect(q.values.some((v) => v instanceof Date)).toBe(false);
  });

  it('devuelve el takenAt exacto en UTC con microsegundos', () => {
    expect(pageIdsQuery(filter, null, 1).text).toContain(
      `to_char(m."takenAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "takenAtKey"`,
    );
  });
});

describe('toSqlCursor / orderByIds / fetchKeysetPage', () => {
  it('mapea el cursor y exige la clave exacta cuando takenAt no es NULL', () => {
    expect(toSqlCursor(null)).toBeNull();
    expect(toSqlCursor({ id: 3, takenAt: null })).toEqual({ id: 3, takenAtKey: null });
    const t = new Date('2026-01-01T00:00:00Z');
    const key = '2026-01-01T00:00:00.000001Z';
    expect(toSqlCursor({ id: 3, takenAt: t, takenAtKey: key })).toEqual({ id: 3, takenAtKey: key });
    expect(() => toSqlCursor({ id: 3, takenAt: t })).toThrow(/exact takenAt key/);
  });

  it('reordena por la lista de ids y omite los que ya no existen', () => {
    expect(orderByIds([3, 1, 2], [{ id: 1 }, { id: 2 }]).map((r) => r.id)).toEqual([1, 2]);
    expect(orderByIds([3, 1, 2], [{ id: 2 }, { id: 3 }, { id: 1 }]).map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it('completa la página si una fila se borra entre la consulta de ids y la carga', async () => {
    const table: DbRow[] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, key: `2026-01-0${i + 1}T00:00:00.000000Z` }));
    const { queryIds, loadRows } = simulatedDb(table);
    loadRows.mockImplementationOnce(async (ids) => ids.filter((id) => id !== 2).map((id) => ({ id, takenAt: null })));
    const page = await fetchKeysetPage(queryIds, loadRows, null, 3);
    expect(page.map((p) => p.id)).toEqual([1, 3, 4]);
    expect(page[2].takenAtKey).toBe('2026-01-04T00:00:00.000000Z');
    expect(queryIds.mock.calls[1]).toEqual([{ id: 3, takenAtKey: '2026-01-03T00:00:00.000000Z' }, 1]);
  });
});

describe('streamMeasurementsCsv (keyset)', () => {
  const collect = async (table: DbRow[], batch: number) => {
    const { queryIds, loadRows } = simulatedDb(table);
    const fetchPage = jest.fn((cursor: PageCursor) => fetchKeysetPage(queryIds, loadRows, cursor, batch));
    const seen: number[] = [];
    await streamMeasurementsCsv(
      fetchPage,
      async (chunk) => { seen.push(Number(chunk.slice(2))); },
      () => false,
      (r) => [String(r.id)],
      batch,
    );
    return { seen, fetchPage };
  };

  it('1 fila NULL + 15 normales con página 10: sin duplicados ni saltos, y termina', async () => {
    const table: DbRow[] = [{ id: 1, key: null }];
    for (let i = 2; i <= 16; i++) table.push({ id: i, key: `2026-01-${String(i).padStart(2, '0')}T00:00:00.000000Z` });
    const { seen, fetchPage } = await collect(table, 10);
    expect(seen).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('varios NULLs que cruzan el borde de página, empates de takenAt e ids desordenados', async () => {
    const t1 = '2026-01-01T00:00:00.000000Z';
    const t2 = '2026-01-02T00:00:00.000000Z';
    const r = (id: number, key: string | null = null): DbRow => ({ id, key });
    const table = [r(20, t2), r(3), r(11, t1), r(5), r(1), r(12, t1), r(4, t2), r(9), r(2, t1), r(30)];
    const expected = [...table].sort(dbCompare).map((x) => x.id);
    // Sin microsegundos, el orden exacto coincide con compareKeys (precisión ms).
    expect(expected).toEqual(
      table.map((x) => ({ id: x.id, takenAt: x.key === null ? null : new Date(x.key) })).sort(compareKeys).map((x) => x.id),
    );
    for (const batch of [1, 2, 3, 4, 10, 50]) {
      const { seen } = await collect(table, batch);
      expect(seen).toEqual(expected);
    }
    expect(expected.slice(0, 5)).toEqual([1, 3, 5, 9, 30]);
  });

  it('microsegundos dentro del mismo ms, ids decrecientes, empates exactos y NULLs: sin dups ni saltos', async () => {
    // Bug original: un cursor `Date` (ms) re-incluía (`> t_ms`) o no encontraba (`= t_ms`) estas filas.
    const table: DbRow[] = [
      { id: 50, key: '2026-01-01T00:00:00.000100Z' },
      { id: 40, key: '2026-01-01T00:00:00.000200Z' },
      { id: 30, key: '2026-01-01T00:00:00.000300Z' },
      { id: 31, key: '2026-01-01T00:00:00.000300Z' },
      { id: 10, key: '2026-01-01T00:00:00.000999Z' },
      { id: 60, key: '2026-01-01T00:00:01.000001Z' },
      { id: 5, key: null },
      { id: 7, key: null },
      { id: 1, key: '2026-01-01T00:00:00.001000Z' },
    ];
    const expected = [5, 7, 50, 40, 30, 31, 10, 1, 60];
    for (const batch of [1, 2, 3, 4, 9, 10]) {
      const { seen } = await collect(table, batch);
      expect(seen).toEqual(expected);
    }
  });

  it('página exacta: pide una página extra vacía y termina', async () => {
    const table: DbRow[] = [{ id: 1, key: null }, { id: 2, key: '2026-01-01T00:00:00.000000Z' }];
    const { seen, fetchPage } = await collect(table, 2);
    expect(seen).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('lanza si la clave no avanza (guarda contra bucles infinitos)', async () => {
    const fetchPage = jest.fn(async (): Promise<Row[]> => [row(1), row(2)]);
    await expect(
      streamMeasurementsCsv(fetchPage, async () => {}, () => false, (r) => [r.label], 2),
    ).rejects.toThrow(/did not advance/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('pasa como cursor la clave (takenAt, id) de la última fila', async () => {
    const t = new Date('2026-01-01T00:00:00Z');
    const pages: Row[][] = [[row(1), { id: 2, takenAt: t, label: 'b' }], []];
    const fetchPage = jest.fn(async (_c: PageCursor) => pages.shift() ?? []);
    await streamMeasurementsCsv(fetchPage, async () => {}, () => false, (r) => [r.label], 2);
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([null, { id: 2, takenAt: t }]);

    const key = '2026-01-01T00:00:00.000500Z';
    const pages2: Row[][] = [[{ id: 2, takenAt: t, takenAtKey: key, label: 'b' }], []];
    const fetchPage2 = jest.fn(async (_c: PageCursor) => pages2.shift() ?? []);
    await streamMeasurementsCsv(fetchPage2, async () => {}, () => false, (r) => [r.label], 1);
    expect(fetchPage2.mock.calls[1][0]).toEqual({ id: 2, takenAt: t, takenAtKey: key });
  });

  it('lanza si takenAt retrocede (en ms) entre páginas', async () => {
    const pages: Row[][] = [[row(1, '2026-01-02T00:00:00Z')], [row(2, '2026-01-01T00:00:00Z')]];
    const fetchPage = jest.fn(async () => pages.shift() ?? []);
    await expect(
      streamMeasurementsCsv(fetchPage, async () => {}, () => false, (r) => [r.label], 1),
    ).rejects.toThrow(/did not advance/);
  });

  it('espera a que writeChunk se resuelva (backpressure) antes de pedir la siguiente fila', async () => {
    const pages: Array<Row[]> = [[row(1), row(2)]];
    const fetchPage = jest.fn(async () => pages.shift() ?? []);
    const order: string[] = [];
    const writeChunkFn = jest.fn(async (chunk: string) => {
      order.push(`write-start:${chunk}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`write-end:${chunk}`);
    });

    await streamMeasurementsCsv(fetchPage, writeChunkFn, () => false, (r) => [r.label], 10);

    expect(order).toEqual([
      'write-start:\r\na',
      'write-end:\r\na',
      'write-start:\r\nb',
      'write-end:\r\nb',
    ]);
  });

  it('corta sin más consultas cuando isAborted() es true', async () => {
    const fetchPage = jest.fn(async (): Promise<Row[]> => [row(1)]);
    const writeChunkFn = jest.fn(async () => {});

    await streamMeasurementsCsv(fetchPage, writeChunkFn, () => true, (r) => [r.label], 10);

    expect(fetchPage).not.toHaveBeenCalled();
    expect(writeChunkFn).not.toHaveBeenCalled();
  });

  it('revisa el aborto por fila: no escribe el resto de la página tras abortar', async () => {
    const fetchPage = jest.fn(async (): Promise<Row[]> => [row(1), row(2), row(3)]);
    let aborted = false;
    const writeChunkFn = jest.fn(async () => { aborted = true; });

    await streamMeasurementsCsv(fetchPage, writeChunkFn, () => aborted, (r) => [r.label], 3);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(writeChunkFn).toHaveBeenCalledTimes(1);
  });

  it('propaga el error de fetchPage sin seguir pidiendo páginas', async () => {
    const err = new Error('db down');
    let calls = 0;
    const fetchPage = jest.fn(async (): Promise<Row[]> => {
      calls++;
      if (calls === 1) return [row(1)];
      throw err;
    });

    await expect(
      streamMeasurementsCsv(fetchPage, async () => {}, () => false, (r) => [r.label], 1),
    ).rejects.toBe(err);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('propaga el error de writeChunk', async () => {
    const err = new Error('socket error');
    const fetchPage = jest.fn(async (): Promise<Row[]> => [row(1)]);
    const writeChunkFn = jest.fn(async () => { throw err; });

    await expect(
      streamMeasurementsCsv(fetchPage, writeChunkFn, () => false, (r) => [r.label], 10),
    ).rejects.toBe(err);
  });
});

describe('writeChunk', () => {
  function fakeRes(writeReturn: boolean) {
    const res = new EventEmitter() as EventEmitter & {
      write: jest.Mock;
      destroyed: boolean;
      writableEnded: boolean;
    };
    res.destroyed = false;
    res.writableEnded = false;
    res.write = jest.fn().mockReturnValue(writeReturn);
    return res;
  }

  const listenerTotal = (res: EventEmitter) =>
    res.listenerCount('drain') + res.listenerCount('close') + res.listenerCount('error');

  it('resuelve de inmediato si res.write devuelve true (sin backpressure)', async () => {
    const res = fakeRes(true);
    await writeChunk(res as any, 'hola');
    expect(res.write).toHaveBeenCalledWith('hola');
  });

  it('espera el evento drain si res.write devuelve false', async () => {
    const res = fakeRes(false);
    let resolved = false;
    const p = writeChunk(res as any, 'hola').then(() => { resolved = true; });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);

    res.emit('drain');
    await p;
    expect(resolved).toBe(true);
  });

  it('también se destraba si el socket emite close o error en vez de drain', async () => {
    for (const ev of ['close', 'error']) {
      const res = fakeRes(false);
      const p = writeChunk(res as any, 'hola');
      res.emit(ev, new Error('x'));
      await p;
      expect(listenerTotal(res)).toBe(0);
    }
  });

  it('no escribe ni espera si close ya ocurrió antes de la escritura (respuesta destruida)', async () => {
    const res = fakeRes(false);
    res.emit('close');
    res.destroyed = true;
    await writeChunk(res as any, 'hola'); // colgaría si esperase un drain/close que ya no llegará
    expect(res.write).not.toHaveBeenCalled();
    expect(listenerTotal(res)).toBe(0);
  });

  it('no espera si la respuesta queda destruida durante el propio write', async () => {
    const res = fakeRes(false);
    res.write.mockImplementation(() => { res.destroyed = true; return false; });
    await writeChunk(res as any, 'hola');
    expect(listenerTotal(res)).toBe(0);
  });

  it('no acumula listeners a lo largo de muchos ciclos de backpressure', async () => {
    const res = fakeRes(false);
    const warn = jest.fn();
    process.on('warning', warn);
    try {
      for (let i = 0; i < 50; i++) {
        const p = writeChunk(res as any, 'x');
        res.emit('drain');
        await p;
      }
      expect(listenerTotal(res)).toBe(0);
    } finally {
      process.off('warning', warn);
    }
  });
});
