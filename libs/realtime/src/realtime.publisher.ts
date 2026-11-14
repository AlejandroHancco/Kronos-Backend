import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { TeamScopeService } from '@app/common';
import { Emitter } from '@socket.io/redis-emitter';
import type Redis from 'ioredis';
import { JobStatusPayload, NotificationPayload } from './payloads';
import { REALTIME_REDIS_CLIENT } from './realtime.redis';

type PublishClient = Pick<Redis, 'publish'> & Partial<Pick<Redis, 'quit' | 'disconnect'>>;

/**
 * Publica eventos Socket.io vía Redis (emitter). Los gateways de la API
 * (con el adapter de Redis) los entregan a los clientes conectados.
 *
 * Usa un cliente Redis propio (REALTIME_REDIS_CLIENT). El emitter llama a
 * publish() sin manejar la promesa: aquí se envuelve para que un fallo de
 * Redis se registre como warning y nunca acabe en un unhandled rejection.
 */
@Injectable()
export class RealtimePublisher implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimePublisher.name);
  private readonly emitter: Emitter;

  constructor(
    @Inject(REALTIME_REDIS_CLIENT) private readonly redis: PublishClient,
    private readonly teamScope: TeamScopeService,
  ) {
    const safeClient = {
      publish: (channel: string, message: string | Buffer): Promise<number> => {
        try {
          return Promise.resolve(redis.publish(channel, message)).catch((err: unknown) => {
            this.logPublishFailure(channel, err);
            return 0;
          });
        } catch (err) {
          this.logPublishFailure(channel, err);
          return Promise.resolve(0);
        }
      },
    };
    this.emitter = new Emitter(safeClient);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.redis.quit) await this.redis.quit();
    } catch {
      this.redis.disconnect?.();
    }
  }

  private logPublishFailure(channel: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(`Realtime publish failed on ${channel}: ${message}`);
  }

  private get kronos() {
    return this.emitter.of('/kronos');
  }

  private get measurements() {
    return this.emitter.of('/measurements');
  }

  measurementComplete(taskId: number, data: Record<string, unknown>): void {
    this.kronos.to(`task:${taskId}`).emit('measurement:complete', { taskId, ...data });
    this.logger.log(`measurement:complete emitted to task:${taskId}`);
  }

  jobStatus(userId: string, status: JobStatusPayload): void {
    this.kronos.to(`user:${userId}`).emit('job:status', status);
    this.logger.debug(`job:status ${status.status} emitted to user:${userId}`);
  }

  notification(userId: string, n: NotificationPayload): void {
    this.kronos.to(`user:${userId}`).emit('notification', n);
    this.logger.log(`notification emitted to user:${userId}`);
  }

  /** Cambio online/offline de un dispositivo: solo a las salas de los equipos del proyecto. */
  async deviceStatus(deviceId: string, projectId: string, status: string): Promise<void> {
    const teamIds = await this.teamScope.teamIdsForProject(projectId);
    for (const teamId of teamIds) {
      this.kronos.to(`team:${teamId}`).emit('device:status', { deviceId, projectId, status });
    }
    this.logger.log(
      `device:status ${status} emitted for device ${deviceId} to ${teamIds.length} team(s)`,
    );
  }

  measurementProgress(
    userId: string,
    jobId: string,
    channel: number,
    total: number,
    percent: number,
    message: string,
  ): void {
    this.measurements.to(userId).emit('measurement:progress', {
      jobId,
      channel,
      total,
      percent,
      status: 'measuring',
      message,
    });
    this.logger.debug(
      `📊 Progress emitted - User: ${userId}, Channel: ${channel}/${total} (${percent}%)`,
    );
  }

  measurementCompleted(
    userId: string,
    jobId: string,
    measurementId: number,
    takenAt: Date,
    totalPoints: number,
    data: unknown,
    sensorValues: unknown,
    acquisition: unknown,
    channels: number[],
  ): void {
    this.measurements.to(userId).emit('measurement:completed', {
      jobId,
      measurementId,
      takenAt,
      totalPoints,
      data,
      sensorValues,
      acquisition,
      channels,
    });
    this.logger.log(
      `✅ Measurement completed - User: ${userId}, ID: ${measurementId}, Points: ${totalPoints}`,
    );
  }

  measurementError(userId: string, jobId: string, message: string): void {
    this.measurements.to(userId).emit('measurement:error', { jobId, message });
    this.logger.error(`❌ Measurement error - User: ${userId}, Message: ${message}`);
  }
}
