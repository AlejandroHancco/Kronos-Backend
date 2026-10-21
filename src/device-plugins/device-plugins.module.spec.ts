import { Test } from '@nestjs/testing';
import { DevicePluginsModule } from './device-plugins.module';
import { DevicePluginRegistry } from './core/device-plugin.registry';
import { PrismaService } from '../prisma/prisma.service';

it('DevicePluginsModule registra por DI todos los plugins de plugins/index.ts', async () => {
  const mod = await Test.createTestingModule({ imports: [DevicePluginsModule] })
    .overrideProvider(PrismaService).useValue({})
    .compile();
  const types = mod.get(DevicePluginRegistry).catalog().map((e) => e.deviceType).sort();
  expect(types).toEqual(['analyzer', 'mux', 'sim-impedance']);
});
