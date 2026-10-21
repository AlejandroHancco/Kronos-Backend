import { LineSocket } from './line-socket';
import type { ScpiTransport } from './scpi-transport';

export const PROLOGIX_PORT = 1234;

/** Espera de lectura del adaptador (`++read_tmo_ms`, máximo del Prologix). */
export const PROLOGIX_READ_TIMEOUT_MS = 3000;

/**
 * SCPI a un equipo GPIB a través de un adaptador compatible con Prologix GPIB-ETHERNET (Prologix o AR488).
 * Modo controlador, lectura explícita con `++read eoi`; el adaptador termina cada comando con LF (`++eos 2`).
 * El adaptador deja de leer del bus tras `++read_tmo_ms` (máx. 3 s): para consultas más largas
 * (p. ej. `*OPC?` de un barrido lento) `query` reenvía `++read eoi` hasta agotar el timeout del llamador.
 */
export class PrologixScpi implements ScpiTransport {
  private constructor(
    private readonly s: LineSocket,
    private readonly defaultTimeoutMs: number,
    private readonly readWindowMs: number,
  ) {}

  /** `readWindowMs`: cuánto esperar cada `++read eoi` antes de reenviarlo (por defecto la espera del adaptador + 500 ms). */
  static async open(
    host: string,
    port: number,
    gpibAddress: number,
    opts: { connectTimeoutMs?: number; defaultTimeoutMs?: number; readWindowMs?: number } = {},
  ): Promise<PrologixScpi> {
    let s: LineSocket;
    try {
      s = await LineSocket.open(host, port, { connectTimeoutMs: opts.connectTimeoutMs ?? 3000 });
    } catch {
      throw new Error(`Sin respuesta del adaptador GPIB en ${host}:${port}`);
    }
    for (const cmd of ['++mode 1', `++addr ${gpibAddress}`, '++auto 0', '++eoi 1', '++eos 2', `++read_tmo_ms ${PROLOGIX_READ_TIMEOUT_MS}`]) {
      s.send(cmd + '\n');
    }
    return new PrologixScpi(s, opts.defaultTimeoutMs ?? 10_000, opts.readWindowMs ?? PROLOGIX_READ_TIMEOUT_MS + 500);
  }

  async write(command: string): Promise<void> {
    this.s.send(command + '\n');
  }

  async query(command: string, timeoutMs = this.defaultTimeoutMs): Promise<string> {
    this.s.send(command + '\n');
    const deadline = Date.now() + timeoutMs;
    for (let remaining = timeoutMs; remaining > 0; remaining = deadline - Date.now()) {
      this.s.send('++read eoi\n');
      const line = await this.s.waitLine(Math.min(remaining, this.readWindowMs));
      if (line !== null) return line;
    }
    // Igual que LineSocket.readLine: tras un timeout la conexión queda inutilizable
    // (una respuesta tardía se confundiría con la de la siguiente consulta).
    const error = new Error('Tiempo de espera agotado esperando respuesta');
    this.s.abort(error);
    throw error;
  }

  close(): void {
    this.s.close();
  }
}
