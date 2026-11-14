import { Test, TestingModule } from '@nestjs/testing';
import { DiscoveryService } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bull';
import RedisMock from 'ioredis-mock';
import { PrismaService } from '@app/database';
import { REDIS_CLIENT } from '@app/redis';
import { REALTIME_REDIS_CLIENT } from '@app/realtime';
import { DEVICE_OPS_QUEUE, MEASUREMENTS_QUEUE } from '@app/queue';
import { WorkerModule } from './worker.module';
import { HealthController } from './health.controller';
import { SchedulerService } from './scheduler/scheduler.service';
import { MeasurementProcessor } from './processors/measurement.processor';
import { DeviceOpsProcessor } from './processors/device-ops.processor';
import { DeviceHealthService } from './devices/device-health.service';

describe('WorkerModule', () => {
  const original = process.env.REDIS_URL;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const queueMock = { add: jest.fn(), process: jest.fn(), on: jest.fn() };
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
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

  afterAll(() => {
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
  });

  it('provides the scheduler, processors and device health service', () => {
    expect(moduleRef.get(SchedulerService, { strict: false })).toBeInstanceOf(SchedulerService);
    expect(moduleRef.get(MeasurementProcessor, { strict: false })).toBeInstanceOf(
      MeasurementProcessor,
    );
    expect(moduleRef.get(DeviceHealthService, { strict: false })).toBeInstanceOf(
      DeviceHealthService,
    );
    expect(moduleRef.get(DeviceOpsProcessor, { strict: false })).toBeInstanceOf(
      DeviceOpsProcessor,
    );
  });

  it('does not include the api KronosGateway', () => {
    const names = moduleRef
      .get(DiscoveryService, { strict: false })
      .getProviders()
      .map((w) => w.metatype?.name);
    expect(names).toContain('SchedulerService'); // discovery sees real providers
    expect(names).not.toContain('KronosGateway');
    expect(names).not.toContain('MeasurementsGateway');
  });

  it('exposes HealthController as its only controller', () => {
    const discovery = moduleRef.get(DiscoveryService, { strict: false });
    const controllers = discovery.getControllers().map((w) => w.metatype);
    expect(controllers).toEqual([HealthController]);
  });
});
