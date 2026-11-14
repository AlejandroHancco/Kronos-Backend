import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import Redis from 'ioredis';
import { PrismaService } from '@app/database';
import { REDIS_CLIENT } from '@app/redis';

/**
 * Health check del worker (sin guards), mismo formato que la API.
 * GET /health
 *
 * El cuerpo es siempre el mismo; responde 503 si la base de datos o Redis
 * están en error para que el HEALTHCHECK del contenedor falle.
 */
@Controller('health')
export class HealthController {
  constructor(
    private prisma: PrismaService,
    @Inject(REDIS_CLIENT) private redis: Redis,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const services = {
      database: await this.checkDatabase(),
      redis: await this.checkRedis(),
    };
    if (services.database === 'error' || services.redis === 'error') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services,
    };
  }

  private async checkDatabase(): Promise<string> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async checkRedis(): Promise<string> {
    try {
      await this.redis.ping();
      return 'ok';
    } catch {
      return 'error';
    }
  }
}
