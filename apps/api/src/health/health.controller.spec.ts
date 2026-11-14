import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '@app/database';
import { REDIS_CLIENT } from '@app/redis';
import { HealthController } from './health.controller';

describe('api HealthController (GET /health)', () => {
  let app: INestApplication;
  const prisma = { $queryRaw: jest.fn() };
  const redis = { ping: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redis.ping.mockResolvedValue('PONG');
  });

  const expectBody = (body: any, database: string, redisState: string) => {
    expect(body).toEqual({
      status: 'ok',
      timestamp: expect.any(String),
      services: { database, redis: redisState },
    });
  };

  it('returns 200 when database and redis are ok', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expectBody(res.body, 'ok', 'ok');
  });

  it('returns 503 with the same body when the database is down', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(503);
    expectBody(res.body, 'error', 'ok');
  });

  it('returns 503 with the same body when redis is down', async () => {
    redis.ping.mockRejectedValue(new Error('redis down'));
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(503);
    expectBody(res.body, 'ok', 'error');
  });
});
