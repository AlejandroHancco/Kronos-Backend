import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import { DEVICE_OPS_QUEUE } from './queue.constants';
import type { DeviceOpData, DeviceOpName } from './jobs';

/** El worker no respondió a tiempo (o la cola no está disponible). */
export class DeviceOpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceOpTimeoutError';
  }
}

/** El worker terminó la operación con error; `message` es el mensaje del worker. */
export class DeviceOpFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceOpFailedError';
  }
}

type Finished<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Cliente de la cola 'device-ops': la API no abre sockets hacia el laboratorio, delega la
 * operación en el worker y espera su resultado.
 *
 * No usa Job.finished(): deja listeners globales y un sondeo cada 5 s vivos hasta que el job
 * termina (nunca, si se elimina tras el timeout). Aquí los listeners son propios y se quitan
 * siempre en el finally.
 */
@Injectable()
export class DeviceOpsClient {
  constructor(@InjectQueue(DEVICE_OPS_QUEUE) private readonly queue: Queue<DeviceOpData>) {}

  async request<T>(name: DeviceOpName, data: DeviceOpData, timeoutMs: number): Promise<T> {
    let job: Job<DeviceOpData>;
    try {
      job = await this.queue.add(name, data, {
        attempts: 1,
        // Se conserva el resultado unos segundos para poder leerlo por estado
        // si el evento global llega antes de suscribirse (o se pierde).
        removeOnComplete: { age: 60 },
        removeOnFail: { age: 60 },
      });
    } catch (err) {
      throw new DeviceOpTimeoutError(`no se pudo encolar ${name}: ${(err as Error).message}`);
    }
    return this.waitForJobResult<T>(job, timeoutMs);
  }

  private async waitForJobResult<T>(job: Job<DeviceOpData>, timeoutMs: number): Promise<T> {
    const queue = this.queue;
    const jobId = String(job.id);
    let timer: NodeJS.Timeout | undefined;
    let onCompleted: ((id: unknown, result: unknown) => void) | undefined;
    let onFailed: ((id: unknown, reason: unknown) => void) | undefined;

    try {
      return await new Promise<T>((resolve, reject) => {
        onCompleted = (id, result) => {
          if (String(id) === jobId) resolve(parseJobResult<T>(result));
        };
        onFailed = (id, reason) => {
          if (String(id) === jobId) reject(new DeviceOpFailedError(String(reason)));
        };
        queue.on('global:completed', onCompleted);
        queue.on('global:failed', onFailed);

        timer = setTimeout(() => {
          // Último chequeo por estado antes de dar la operación por fallida.
          this.settleOnTimeout<T>(job, timeoutMs).then(resolve, reject);
        }, timeoutMs);

        // Cierra la carrera: el job pudo terminar antes de suscribirse.
        this.readFinishedResult<T>(job).then(
          (finished) => {
            if (!finished) return;
            if (finished.ok) resolve(finished.value);
            else reject(new DeviceOpFailedError(finished.reason));
          },
          () => undefined, // el timeout decide
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (onCompleted) queue.removeListener('global:completed', onCompleted);
      if (onFailed) queue.removeListener('global:failed', onFailed);
    }
  }

  private async readFinishedResult<T>(job: Job<DeviceOpData>): Promise<Finished<T> | undefined> {
    const state = await job.getState();
    if (state !== 'completed' && state !== 'failed') return undefined;
    const fresh = (await this.queue.getJob(job.id)) ?? job;
    if (state === 'completed') return { ok: true, value: parseJobResult<T>(fresh.returnvalue) };
    return { ok: false, reason: fresh.failedReason ?? 'job failed' };
  }

  private async settleOnTimeout<T>(job: Job<DeviceOpData>, timeoutMs: number): Promise<T> {
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      const finished = await this.readFinishedResult<T>(job);
      if (finished?.ok) return finished.value;
      throw new DeviceOpFailedError(finished?.reason ?? 'job failed');
    }
    // Solo se retira si nadie lo ha tomado; si está activo, el worker lo termina
    // y removeOnComplete/removeOnFail lo limpian.
    if (state === 'waiting' || state === 'delayed' || state === 'paused') {
      try {
        await job.remove();
      } catch {
        // best-effort
      }
    }
    throw new DeviceOpTimeoutError(`timeout tras ${timeoutMs}ms (estado: ${state})`);
  }
}

/** Los eventos globales de Bull entregan el resultado serializado como JSON. */
function parseJobResult<T>(result: unknown): T {
  if (typeof result === 'string') {
    try {
      return JSON.parse(result) as T;
    } catch {
      return result as T;
    }
  }
  return result as T;
}
