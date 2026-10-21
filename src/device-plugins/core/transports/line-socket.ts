import * as net from 'net';

export interface LineSocketOptions { connectTimeoutMs?: number; terminator?: '\n' | '\r\n' }

interface PendingRead { resolve: (line: string | null) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }

/** Socket TCP orientado a líneas: lectura hasta \n (ignorando \r), con cola de líneas y timeouts por lectura. */
export class LineSocket {
  private buffer = '';
  private lines: string[] = [];
  private waiter: PendingRead | null = null;
  private failure: Error | null = null;

  private constructor(private readonly socket: net.Socket, readonly terminator: string) {
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(this.failure ?? new Error('Conexión cerrada por el dispositivo')));
  }

  static open(host: string, port: number, opts: LineSocketOptions = {}): Promise<LineSocket> {
    const { connectTimeoutMs = 3000, terminator = '\n' } = opts;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Tiempo de espera agotado conectando a ${host}:${port}`)); }, connectTimeoutMs);
      const onConnectError = (e: Error) => { clearTimeout(timer); socket.destroy(); reject(e); };
      socket.once('error', onConnectError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeListener('error', onConnectError);
        resolve(new LineSocket(socket, terminator));
      });
    });
  }

  send(text: string): void {
    if (this.failure) throw this.failure;
    this.socket.write(text, 'latin1');
  }

  readLine(timeoutMs: number): Promise<string> {
    if (this.waiter) return Promise.reject(new Error('Ya hay una lectura en curso'));
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.failure = new Error('Tiempo de espera agotado esperando respuesta');
        this.socket.destroy();
        reject(this.failure);
      }, timeoutMs);
      this.waiter = { resolve: resolve as (line: string | null) => void, reject, timer };
    });
  }

  /**
   * Como readLine, pero al vencer devuelve null SIN envenenar la conexión (para reintentos del
   * llamador, p. ej. reenviar `++read eoi` a un adaptador GPIB). Una línea tardía queda en la cola.
   */
  waitLine(timeoutMs: number): Promise<string | null> {
    if (this.waiter) return Promise.reject(new Error('Ya hay una lectura en curso'));
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  /** Marca la conexión como inutilizable (rechaza lo pendiente y las lecturas futuras) y la cierra. */
  abort(error: Error): void {
    this.fail(error);
    this.socket.destroy();
  }

  close(): void {
    this.socket.destroy();
  }

  /** Rechaza la lectura pendiente (si hay) y recuerda el primer error ocurrido. */
  private fail(error: Error): void {
    this.failure ??= error;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(this.failure);
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('latin1').replace(/\r/g, '');
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve(line);
      } else {
        this.lines.push(line);
      }
    }
  }
}
