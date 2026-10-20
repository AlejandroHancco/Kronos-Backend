import { EventEmitter } from 'node:events';
import {
  compareKeys,
  keysetAfter,
  PageCursor,
  streamMeasurementsCsv,
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

/**
 * Evaluador mínimo del subconjunto de Prisma.MeasurementWhereInput que produce keysetAfter
 * (OR, takenAt null/{not:null}/{gt}/igualdad, id {gt}) para simular la paginación en memoria.
 */
function matches(r: StreamableRow, where: any): boolean {
  if (where.OR) return (where.OR as any[]).some((w) => matches(r, w));
  for (const [key, cond] of Object.entries(where)) {
    const v = (r as any)[key];
    if (cond === null) { if (v !== null) return false; continue; }
    if (cond instanceof Date) { if (v === null || v.getTime() !== cond.getTime()) return false; continue; }
    if (typeof cond === 'object') {
      const c = cond as any;
      if ('not' in c && c.not === null && v === null) return false;
      if ('gt' in c) {
        if (v === null) return false;
        const a = v instanceof Date ? v.getTime() : v;
        const b = c.gt instanceof Date ? c.gt.getTime() : c.gt;
        if (!(a > b)) return false;
      }
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

/** Simula `findMany({ where: AND(keysetAfter(cursor)), orderBy: takenAt NULLS FIRST, id, take })`. */
function simulatedFetch(table: Row[], take: number) {
  const sorted = [...table].sort(compareKeys);
  return jest.fn(async (cursor: PageCursor) => sorted.filter((r) => matches(r, keysetAfter(cursor))).slice(0, take));
}

describe('keysetAfter', () => {
  it('sin cursor no filtra', () => {
    expect(keysetAfter(null)).toEqual({});
  });

  it('dentro del bloque NULL: NULLs con id mayor o cualquier fila no nula', () => {
    expect(keysetAfter({ id: 7, takenAt: null })).toEqual({
      OR: [{ takenAt: null, id: { gt: 7 } }, { takenAt: { not: null } }],
    });
  });

  it('tras el bloque NULL: takenAt mayor, o igual con id mayor (excluye NULLs)', () => {
    const t = new Date('2026-01-05T00:00:00Z');
    expect(keysetAfter({ id: 9, takenAt: t })).toEqual({
      OR: [{ takenAt: { gt: t } }, { takenAt: t, id: { gt: 9 } }],
    });
    expect(matches(row(1), keysetAfter({ id: 9, takenAt: t }))).toBe(false);
  });
});

describe('streamMeasurementsCsv (keyset)', () => {
  const collect = async (table: Row[], batch: number) => {
    const fetchPage = simulatedFetch(table, batch);
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
    const table = [row(1)];
    for (let i = 2; i <= 16; i++) table.push(row(i, `2026-01-${String(i).padStart(2, '0')}T00:00:00Z`));
    const { seen, fetchPage } = await collect(table, 10);
    expect(seen).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('varios NULLs que cruzan el borde de página, empates de takenAt e ids desordenados', async () => {
    const t1 = '2026-01-01T00:00:00Z';
    const t2 = '2026-01-02T00:00:00Z';
    const table = [
      row(20, t2), row(3), row(11, t1), row(5), row(1), row(12, t1), row(4, t2), row(9), row(2, t1), row(30),
    ];
    const expected = [...table].sort(compareKeys).map((r) => r.id);
    for (const batch of [1, 2, 3, 4, 10, 50]) {
      const { seen } = await collect(table, batch);
      expect(seen).toEqual(expected);
    }
    expect(expected.slice(0, 5)).toEqual([1, 3, 5, 9, 30]);
  });

  it('página exacta: pide una página extra vacía y termina', async () => {
    const table = [row(1), row(2, '2026-01-01T00:00:00Z')];
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
