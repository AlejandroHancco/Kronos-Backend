import * as net from 'net';
import { LineSocket } from './line-socket';
import { RawTcpScpi } from './raw-tcp-scpi';
import { PrologixScpi } from './prologix-scpi';

/** Servidor que registra cada línea recibida y responde con `reply(line)` (null = no responde). */
function fakeServer(reply: (line: string) => string | null) {
  const received: string[] = [];
  const server = net.createServer((s) => {
    let buf = '';
    s.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        received.push(line);
        const r = reply(line);
        if (r !== null) s.write(r + '\n');
      }
    });
  });
  return new Promise<{ port: number; received: string[]; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as net.AddressInfo).port, received, close: () => server.close() })));
}

describe('transports', () => {
  it('RawTcpScpi: write no espera respuesta; query lee hasta \\n', async () => {
    const srv = await fakeServer((l) => (l.endsWith('?') ? 'OK,1' : null));
    const t = await RawTcpScpi.open('127.0.0.1', srv.port);
    await t.write(':FREQ:STAR 9000');
    await expect(t.query('*IDN?')).resolves.toBe('OK,1');
    expect(srv.received).toEqual([':FREQ:STAR 9000', '*IDN?']);
    t.close(); srv.close();
  });
  it('RawTcpScpi: terminador \\r\\n', async () => {
    const srv = await fakeServer((l) => (l.endsWith('?') ? 'x' : null));
    const t = await RawTcpScpi.open('127.0.0.1', srv.port, { terminator: '\r\n' });
    await t.query('A?');
    expect(srv.received).toEqual(['A?']);
    t.close(); srv.close();
  });
  it('query vence con timeout', async () => {
    const srv = await fakeServer(() => null);
    const t = await RawTcpScpi.open('127.0.0.1', srv.port);
    await expect(t.query('*OPC?', 50)).rejects.toThrow('Tiempo de espera agotado');
    t.close(); srv.close();
  });
  it('PrologixScpi: configura el adaptador y lee con ++read eoi', async () => {
    const srv = await fakeServer((l) => (l === '++read eoi' ? '1' : null));
    const t = await PrologixScpi.open('127.0.0.1', srv.port, 18);
    await t.write(':INIT:CONT OFF');
    await expect(t.query('*OPC?')).resolves.toBe('1');
    expect(srv.received).toEqual([
      '++mode 1', '++addr 18', '++auto 0', '++eoi 1', '++eos 2', '++read_tmo_ms 3000', ':INIT:CONT OFF', '*OPC?', '++read eoi',
    ]);
    t.close(); srv.close();
  });
  it('PrologixScpi: si el adaptador agota su espera de lectura, reenvía ++read eoi hasta el timeout del llamador', async () => {
    let reads = 0;
    const srv = await fakeServer((l) => (l === '++read eoi' && ++reads === 2 ? '1' : null));
    const t = await PrologixScpi.open('127.0.0.1', srv.port, 18, { readWindowMs: 100 });
    await expect(t.query('*OPC?', 2000)).resolves.toBe('1');
    expect(srv.received.slice(-3)).toEqual(['*OPC?', '++read eoi', '++read eoi']);
    // la conexión sigue utilizable
    await t.write(':INIT:CONT OFF');
    t.close(); srv.close();
  });
  it('PrologixScpi: sin respuesta tras varios ++read eoi, vence con el timeout del llamador', async () => {
    const srv = await fakeServer(() => null);
    const t = await PrologixScpi.open('127.0.0.1', srv.port, 18, { readWindowMs: 50 });
    const start = Date.now();
    await expect(t.query('*OPC?', 300)).rejects.toThrow('Tiempo de espera agotado');
    expect(Date.now() - start).toBeLessThan(1000);
    expect(srv.received.filter((l) => l === '++read eoi').length).toBeGreaterThanOrEqual(2);
    t.close(); srv.close();
  });
  it('LineSocket.waitLine: null al vencer sin envenenar la conexión', async () => {
    const srv = await fakeServer((l) => (l === 'go' ? 'ok' : null));
    const s = await LineSocket.open('127.0.0.1', srv.port);
    await expect(s.waitLine(50)).resolves.toBeNull();
    s.send('go\n');
    await expect(s.waitLine(500)).resolves.toBe('ok');
    s.close(); srv.close();
  });
  it('PrologixScpi: adaptador inaccesible', async () => {
    await expect(PrologixScpi.open('127.0.0.1', 1, 18, { connectTimeoutMs: 200 }))
      .rejects.toThrow('Sin respuesta del adaptador GPIB en 127.0.0.1:1');
  });
  it('LineSocket ignora \\r y separa líneas en un mismo chunk', async () => {
    const srv = await fakeServer((l) => (l === 'go' ? 'a\r\nb' : null));
    const s = await LineSocket.open('127.0.0.1', srv.port);
    s.send('go\n');
    await expect(s.readLine(500)).resolves.toBe('a');
    await expect(s.readLine(500)).resolves.toBe('b');
    s.close(); srv.close();
  });

  it('el servidor cierra la conexión tras recibir la consulta: query rechaza rápido con un error que no es de timeout', async () => {
    const server = net.createServer((s) => {
      s.on('data', () => s.destroy());
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
    const t = await RawTcpScpi.open('127.0.0.1', port);
    const start = Date.now();
    await expect(t.query('*IDN?', 5000)).rejects.not.toThrow('Tiempo de espera agotado');
    expect(Date.now() - start).toBeLessThan(1000);
    t.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('tras un query con timeout, una segunda consulta rechaza (conexión inutilizable)', async () => {
    const srv = await fakeServer(() => null);
    const t = await RawTcpScpi.open('127.0.0.1', srv.port);
    await expect(t.query('*OPC?', 50)).rejects.toThrow('Tiempo de espera agotado');
    await expect(t.query('*OPC?', 500)).rejects.toThrow();
    t.close(); srv.close();
  });

  it('readLine concurrente rechaza con "Ya hay una lectura en curso"', async () => {
    const srv = await fakeServer(() => null);
    const s = await LineSocket.open('127.0.0.1', srv.port);
    const first = s.readLine(500);
    await expect(s.readLine(500)).rejects.toThrow('Ya hay una lectura en curso');
    s.close();
    await expect(first).rejects.toThrow();
    srv.close();
  });

  it('close() mientras una consulta está pendiente la rechaza de inmediato', async () => {
    const srv = await fakeServer(() => null);
    const s = await LineSocket.open('127.0.0.1', srv.port);
    const pending = s.readLine(5000);
    s.close();
    await expect(pending).rejects.toThrow();
    srv.close();
  });
});
