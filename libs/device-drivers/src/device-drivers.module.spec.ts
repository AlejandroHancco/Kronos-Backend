import { Test } from '@nestjs/testing';
import { LaasCatalogModule, LaasCatalog } from '@app/laas-catalog';
import { DeviceDriversModule } from './device-drivers.module';
import { DeviceDriverRegistry } from './device-driver.registry';

it('DeviceDriversModule registra por DI todos los drivers de drivers/index.ts, en paridad con el catálogo', async () => {
  const mod = await Test.createTestingModule({ imports: [LaasCatalogModule, DeviceDriversModule] }).compile();
  const registry = mod.get(DeviceDriverRegistry);
  const types = ['agilent-e4402b', 'hioki-im3570', 'kronos-mux-16', 'sim-impedance', 'sim-spectrum', 'sim-temperature'];
  expect(types.every((t) => registry.has(t))).toBe(true);
  expect(() => registry.assertParity(mod.get(LaasCatalog))).not.toThrow();
});
