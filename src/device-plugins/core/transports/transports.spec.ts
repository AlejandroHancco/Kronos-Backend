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
      '++mode 1', '++addr 18', '++auto 0', '++eoi 1', '++eos 2', ':INIT:CONT OFF', '*OPC?', '++read eoi',
    ]);
    t.close(); srv.close();
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
});
