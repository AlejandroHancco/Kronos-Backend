import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

/**
 * Adapter Socket.io respaldado por Redis: permite que eventos publicados por
 * otros procesos (worker, vía Emitter) lleguen a los clientes de esta API.
 */
export class RedisIoAdapter extends IoAdapter {
  private pub: Redis;
  private sub: Redis;

  constructor(app?: INestApplicationContext) {
    super(app);
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL is required');
    }
    this.pub = new Redis(url);
    this.sub = this.pub.duplicate();
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  async close(server?: any) {
    this.pub.disconnect();
    this.sub.disconnect();
    return super.close(server);
  }
}
