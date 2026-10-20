import { EventEmitter } from 'node:events';
import { streamMeasurementsCsv, writeChunk, StreamableRow } from './csv-stream';

interface Row extends StreamableRow {
  id: number;
  label: string;
}

describe('streamMeasurementsCsv', () => {
  it('pagina con cursor estable sin saltar ni duplicar filas', async () => {
    const pages: Array<Row[]> = [
      [{ id: 1, label: 'a' }, { id: 2, label: 'b' }],
      [{ id: 3, label: 'c' }, { id: 4, label: 'd' }],
      [],
    ];
    const fetchPage = jest.fn(async (_cursor: number | null) => pages.shift() ?? []);
    const written: string[] = [];
    const writeChunk = jest.fn(async (chunk: string) => { written.push(chunk); });
    const toLines = jest.fn((row: Row) => [row.label]);

    await streamMeasurementsCsv(fetchPage, writeChunk, () => false, toLines);

    // Cursores pasados: null (primera página), luego el id de la última fila de cada página.
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([null, 2, 4]);
    expect(written.join('')).toBe('\r\na\r\nb\r\nc\r\nd');
    expect(toLines).toHaveBeenCalledTimes(4);
  });

  it('espera a que writeChunk se resuelva (backpressure) antes de pedir la siguiente fila', async () => {
    const pages: Array<Row[]> = [[{ id: 1, label: 'a' }, { id: 2, label: 'b' }], []];
    const fetchPage = jest.fn(async () => pages.shift() ?? []);
    const order: string[] = [];
    const writeChunk = jest.fn(async (chunk: string) => {
      order.push(`write-start:${chunk}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`write-end:${chunk}`);
    });

    await streamMeasurementsCsv(fetchPage, writeChunk, () => false, (row) => [row.label]);

    expect(order).toEqual([
      'write-start:\r\na',
      'write-end:\r\na',
      'write-start:\r\nb',
      'write-end:\r\nb',
    ]);
  });

  it('corta sin más consultas cuando isAborted() es true', async () => {
    const fetchPage = jest.fn(async (): Promise<Row[]> => [{ id: 1, label: 'a' }]);
    const writeChunkFn = jest.fn(async () => {});

    await streamMeasurementsCsv(fetchPage, writeChunkFn, () => true, (row) => [row.label]);

    expect(fetchPage).not.toHaveBeenCalled();
    expect(writeChunkFn).not.toHaveBeenCalled();
  });

  it('corta tras la página en curso si isAborted() se vuelve true entre páginas', async () => {
    const pages: Array<Row[]> = [[{ id: 1, label: 'a' }], [{ id: 2, label: 'b' }]];
    const fetchPage = jest.fn(async () => pages.shift() ?? []);
    let aborted = false;
    const writeChunkFn = jest.fn(async () => { aborted = true; });

    await streamMeasurementsCsv(fetchPage, writeChunkFn, () => aborted, (row) => [row.label]);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(writeChunkFn).toHaveBeenCalledTimes(1);
  });

  it('propaga el error de fetchPage sin seguir pidiendo páginas', async () => {
    const err = new Error('db down');
    let calls = 0;
    const fetchPage = jest.fn(async (): Promise<Row[]> => {
      calls++;
      if (calls === 1) return [{ id: 1, label: 'a' }];
      throw err;
    });
    const writeChunkFn = jest.fn(async () => {});

    await expect(
      streamMeasurementsCsv(fetchPage, writeChunkFn, () => false, (row) => [row.label]),
    ).rejects.toBe(err);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('propaga el error de writeChunk', async () => {
    const err = new Error('socket error');
    const fetchPage = jest.fn(async (): Promise<Row[]> => [{ id: 1, label: 'a' }]);
    const writeChunkFn = jest.fn(async () => { throw err; });

    await expect(
      streamMeasurementsCsv(fetchPage, writeChunkFn, () => false, (row) => [row.label]),
    ).rejects.toBe(err);
  });
});

describe('writeChunk', () => {
  function fakeRes(writeReturn: boolean) {
    const res = new EventEmitter() as EventEmitter & { write: jest.Mock; destroyed: boolean };
    res.destroyed = false;
    res.write = jest.fn().mockReturnValue(writeReturn);
    return res;
  }

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

  it('también se destraba si el socket emite close en vez de drain', async () => {
    const res = fakeRes(false);
    let resolved = false;
    const p = writeChunk(res as any, 'hola').then(() => { resolved = true; });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(resolved).toBe(false);

    res.emit('close');
    await p;
    expect(resolved).toBe(true);
  });
});
