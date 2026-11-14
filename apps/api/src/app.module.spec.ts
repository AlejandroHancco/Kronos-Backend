import { Test, TestingModule } from '@nestjs/testing';
import { DiscoveryService } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bull';
import RedisMock from 'ioredis-mock';
import { PrismaService } from '@app/database';
import { REDIS_CLIENT } from '@app/redis';
import { REALTIME_REDIS_CLIENT } from '@app/realtime';
import { DEVICE_OPS_QUEUE, MEASUREMENTS_QUEUE } from '@app/queue';
import { AppModule } from './app.module';

describe('api AppModule', () => {
  const ENV = {
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'test-secret',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
    SUPABASE_JWT_SECRET: 'test-secret',
  };
  const saved: Record<string, string | undefined> = {};
  let moduleRef: TestingModule;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const queueMock = { add: jest.fn(), process: jest.fn(), on: jest.fn() };
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(REDIS_CLIENT)
      .useValue(new RedisMock())
      .overrideProvider(REALTIME_REDIS_CLIENT)
      .useValue(new RedisMock())
      .overrideProvider(getQueueToken(MEASUREMENTS_QUEUE))
      .useValue(queueMock)
      .overrideProvider(getQueueToken(DEVICE_OPS_QUEUE))
      .useValue(queueMock)
      .compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('contains no worker-only or socket-opening providers', () => {
    const names = moduleRef
      .get(DiscoveryService, { strict: false })
      .getProviders()
      .map((w) => w.metatype?.name)
      .filter(Boolean);
    for (const forbidden of [
      'SchedulerService',
      'MeasurementProcessor',
      'DeviceHealthService',
      'DeviceOpsProcessor',
      'MeasurementExecutor',
      'DeviceDriverRegistry',
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // sanity: discovery does see the api providers
    expect(names).toContain('DevicesService');
  });
});
