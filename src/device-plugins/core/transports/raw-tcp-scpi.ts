import { LineSocket, type LineSocketOptions } from './line-socket';
import type { ScpiTransport } from './scpi-transport';

export interface RawTcpOptions extends LineSocketOptions { writeDelayMs?: number; defaultTimeoutMs?: number }

/** SCPI directo por socket (equipos con LAN, o un servidor serie-Ethernet delante de RS-232). */
export class RawTcpScpi implements ScpiTransport {
  private constructor(private readonly s: LineSocket, private readonly writeDelayMs: number, private readonly defaultTimeoutMs: number) {}

  static async open(host: string, port: number, opts: RawTcpOptions = {}): Promise<RawTcpScpi> {
    return new RawTcpScpi(await LineSocket.open(host, port, opts), opts.writeDelayMs ?? 0, opts.defaultTimeoutMs ?? 10_000);
  }

  async write(command: string): Promise<void> {
    this.s.send(command + this.s.terminator);
    if (this.writeDelayMs > 0) await new Promise((r) => setTimeout(r, this.writeDelayMs));
  }

  async query(command: string, timeoutMs = this.defaultTimeoutMs): Promise<string> {
    this.s.send(command + this.s.terminator);
    return this.s.readLine(timeoutMs);
  }

  close(): void {
    this.s.close();
  }
}
