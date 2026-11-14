import { Controller, Get, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '@app/database';
import { REDIS_CLIENT } from '@app/redis';

/**
 * Health check del worker (sin guards), mismo formato que la API.
 * GET /health
 */
@Controller('health')
export class HealthController {
  constructor(
    private prisma: PrismaService,
    @Inject(REDIS_CLIENT) private redis: Redis,
  ) {}

  @Get()
  async check() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        database: await this.checkDatabase(),
        redis: await this.checkRedis(),
      },
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
