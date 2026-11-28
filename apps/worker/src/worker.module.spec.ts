import { Test, TestingModule } from '@nestjs/testing';
import { DiscoveryService } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bull';
import RedisMock from 'ioredis-mock';
import { PrismaService } from '@app/database';
import { REDIS_CLIENT } from '@app/redis';
import { REALTIME_REDIS_CLIENT } from '@app/realtime';
import { DEVICE_OPS_QUEUE, MEASUREMENTS_QUEUE, SCHEDULED_MEASUREMENTS_QUEUE } from '@app/queue';
import { DEVICE_DRIVERS, DEVICE_DRIVER_INSTANCES } from '@app/device-drivers';
import { MeasurementExecutor } from '@app/measurement';
import { WorkerModule } from './worker.module';
import { HealthController } from './health.controller';
import { SchedulerService } from './scheduler/scheduler.service';
import { MeasurementProcessor, ScheduledMeasurementProcessor } from './processors/measurement.processor';
import { MeasurementJobRunner } from './processors/measurement-job.runner';
import { DeviceOpsProcessor } from './processors/device-ops.processor';
import { DeviceHealthService } from './devices/device-health.service';
import { DriverParityCheck } from './driver-parity.check';

function build(drivers?: unknown[]) {
  const queueMock = { add: jest.fn(), process: jest.fn(), on: jest.fn() };
  let builder = Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(PrismaService)
    .useValue({})
    .overrideProvider(REDIS_CLIENT)
    .useValue(new RedisMock())
    .overrideProvider(REALTIME_REDIS_CLIENT)
    .useValue(new RedisMock())
    .overrideProvider(getQueueToken(MEASUREMENTS_QUEUE))
    .useValue(queueMock)
    .overrideProvider(getQueueToken(SCHEDULED_MEASUREMENTS_QUEUE))
    .useValue(queueMock)
    .overrideProvider(getQueueToken(DEVICE_OPS_QUEUE))
    .useValue(queueMock);
  if (drivers) builder = builder.overrideProvider(DEVICE_DRIVER_INSTANCES).useValue(drivers);
  return builder.compile();
}

describe('WorkerModule', () => {
  const original = process.env.REDIS_URL;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    moduleRef = await build();
  });

  afterAll(() => {
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
  });

  it('provee el scheduler, los processors, el health check, el ejecutor de mediciones y el chequeo de paridad', () => {
    for (const cls of [SchedulerService, MeasurementProcessor, ScheduledMeasurementProcessor, MeasurementJobRunner, DeviceHealthService, DeviceOpsProcessor, DriverParityCheck, MeasurementExecutor]) {
      expect(moduleRef.get(cls as any, { strict: false })).toBeInstanceOf(cls);
    }
  });

  it('no incluye controllers ni gateways de negocio de la API', () => {
    const names = moduleRef
      .get(DiscoveryService, { strict: false })
      .getProviders()
      .map((w) => w.metatype?.name);
    expect(names).toContain('SchedulerService'); // discovery ve los providers reales
    expect(names).toContain('TeamScopeService'); // CommonModule (deviceStatus)
    expect(names).toContain('RealtimePublisher');
    for (const forbidden of ['KronosGateway', 'MeasurementsGateway', 'MeasurementSchedulingService', 'DevicesService', 'DeviceConfigurationService']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('expone HealthController como único controller', () => {
    const controllers = moduleRef
      .get(DiscoveryService, { strict: false })
      .getControllers()
      .map((w) => w.metatype);
    expect(controllers).toEqual([HealthController]);
  });

  it('con catálogo y drivers en paridad, la inicialización pasa', async () => {
    const app = moduleRef.createNestApplication();
    await expect(app.init()).resolves.toBeDefined();
    await app.close();
  });

  it('si se rompe la paridad catálogo/drivers, DriverParityCheck.run() falla nombrando el modelo (la inicialización no lo comprueba: lo hace main.ts antes de listen)', async () => {
    const all = DEVICE_DRIVERS.map((D: any) => moduleRef.get(D, { strict: false }));
    const withoutMux = all.filter((d: any) => d.deviceType !== 'kronos-mux-16');
    const broken = await build(withoutMux);
    expect(() => broken.get(DriverParityCheck, { strict: false }).run()).toThrow(
      /Plugin "kronos-mux-16": tiene descripción en el catálogo pero está sin driver/,
    );
    await broken.close().catch(() => undefined);
  });
});
