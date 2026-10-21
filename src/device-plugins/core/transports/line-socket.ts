import * as net from 'net';

export interface LineSocketOptions { connectTimeoutMs?: number; terminator?: '\n' | '\r\n' }

/** Socket TCP orientado a líneas: lectura hasta \n (ignorando \r), con cola de líneas y timeouts por lectura. */
export class LineSocket {
  private buffer = '';
  private lines: string[] = [];
  private waiter: ((line: string) => void) | null = null;
  private failure: Error | null = null;

  private constructor(private readonly socket: net.Socket, readonly terminator: string) {
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (e) => (this.failure = e));
    socket.on('close', () => (this.failure ??= new Error('Conexión cerrada por el dispositivo')));
  }

  static open(host: string, port: number, opts: LineSocketOptions = {}): Promise<LineSocket> {
    const { connectTimeoutMs = 3000, terminator = '\n' } = opts;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Tiempo de espera agotado conectando a ${host}:${port}`)); }, connectTimeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(new LineSocket(socket, terminator)); });
      socket.once('error', (e) => { clearTimeout(timer); socket.destroy(); reject(e); });
    });
  }

  send(text: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(text, 'latin1');
  }

  readLine(timeoutMs: number): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('Tiempo de espera agotado esperando respuesta')); }, timeoutMs);
      this.waiter = (line) => { clearTimeout(timer); resolve(line); };
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('latin1').replace(/\r/g, '');
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(line); } else this.lines.push(line);
    }
  }
}
