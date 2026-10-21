import { LineSocket } from './line-socket';
import type { ScpiTransport } from './scpi-transport';

export const PROLOGIX_PORT = 1234;

/**
 * SCPI a un equipo GPIB a través de un adaptador compatible con Prologix GPIB-ETHERNET (Prologix o AR488).
 * Modo controlador, lectura explícita con `++read eoi`; el adaptador termina cada comando con LF (`++eos 2`).
 */
export class PrologixScpi implements ScpiTransport {
  private constructor(private readonly s: LineSocket, private readonly defaultTimeoutMs: number) {}

  static async open(host: string, port: number, gpibAddress: number, opts: { connectTimeoutMs?: number; defaultTimeoutMs?: number } = {}): Promise<PrologixScpi> {
    let s: LineSocket;
    try {
      s = await LineSocket.open(host, port, { connectTimeoutMs: opts.connectTimeoutMs ?? 3000 });
    } catch {
      throw new Error(`Sin respuesta del adaptador GPIB en ${host}:${port}`);
    }
    for (const cmd of ['++mode 1', `++addr ${gpibAddress}`, '++auto 0', '++eoi 1', '++eos 2']) s.send(cmd + '\n');
    return new PrologixScpi(s, opts.defaultTimeoutMs ?? 10_000);
  }

  async write(command: string): Promise<void> {
    this.s.send(command + '\n');
  }

  async query(command: string, timeoutMs = this.defaultTimeoutMs): Promise<string> {
    this.s.send(command + '\n');
    this.s.send('++read eoi\n');
    return this.s.readLine(timeoutMs);
  }

  close(): void {
    this.s.close();
  }
}
