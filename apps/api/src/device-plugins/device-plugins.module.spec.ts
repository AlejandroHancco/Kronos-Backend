import { Test } from '@nestjs/testing';
import { DevicePluginsModule } from './device-plugins.module';
import { LaasCatalog } from '@app/laas-catalog';
import { PrismaService } from '@app/database';
import { REDIS_CLIENT, RedisModule } from '@app/redis';
import RedisMock from 'ioredis-mock';

it('DevicePluginsModule expone el catálogo LaaS de todos los modelos (sin drivers de E/S)', async () => {
  const mod = await Test.createTestingModule({ imports: [RedisModule, DevicePluginsModule] })
    .overrideProvider(PrismaService).useValue({})
    .overrideProvider(REDIS_CLIENT).useValue(new RedisMock())
    .compile();
  const types = mod.get(LaasCatalog).catalog().map((e) => e.deviceType).sort();
  expect(types).toEqual(['agilent-e4402b', 'hioki-im3570', 'kronos-mux-16', 'sim-impedance', 'sim-spectrum', 'sim-temperature']);
  expect(() => mod.get('DeviceDriverRegistry' as any, { strict: false })).toThrow();
});
