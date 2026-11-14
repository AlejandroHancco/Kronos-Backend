import { Test } from '@nestjs/testing';
import { DevicePluginsModule } from './device-plugins.module';
import { DevicePluginRegistry } from './core/device-plugin.registry';
import { PrismaService } from '@app/database';
import { REDIS_CLIENT, RedisModule } from '@app/redis';
import RedisMock from 'ioredis-mock';

it('DevicePluginsModule registra por DI todos los plugins de plugins/index.ts', async () => {
  const mod = await Test.createTestingModule({ imports: [RedisModule, DevicePluginsModule] })
    .overrideProvider(PrismaService).useValue({})
    .overrideProvider(REDIS_CLIENT).useValue(new RedisMock())
    .compile();
  const types = mod.get(DevicePluginRegistry).catalog().map((e) => e.deviceType).sort();
  expect(types).toEqual(['agilent-e4402b', 'hioki-im3570', 'kronos-mux-16', 'sim-impedance', 'sim-spectrum', 'sim-temperature']);
});
