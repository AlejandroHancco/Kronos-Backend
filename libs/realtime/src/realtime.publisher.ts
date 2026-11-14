import { Inject, Injectable, Logger } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '@app/redis';
import { JobStatusPayload, NotificationPayload } from './payloads';

/**
 * Publica eventos Socket.io vía Redis (emitter). Los gateways de la API
 * (con el adapter de Redis) los entregan a los clientes conectados.
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger(RealtimePublisher.name);
  private readonly emitter: Emitter;

  constructor(@Inject(REDIS_CLIENT) redis: Redis) {
    this.emitter = new Emitter(redis);
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

  deviceStatus(deviceId: string, projectId: string, status: string): void {
    this.kronos.emit('device:status', { deviceId, projectId, status });
    this.logger.log(`device:status ${status} emitted for device ${deviceId}`);
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
  ): void {
    this.measurements.to(userId).emit('measurement:completed', {
      jobId,
      measurementId,
      takenAt,
      totalPoints,
      data,
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
