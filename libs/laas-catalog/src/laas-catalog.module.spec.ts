import { Test } from '@nestjs/testing';
import { LaasCatalogModule } from './laas-catalog.module';
import { LaasCatalog } from './laas-catalog';

it('LaasCatalogModule resuelve LaasCatalog por DI con todos los modelos de models/index.ts', async () => {
  const mod = await Test.createTestingModule({ imports: [LaasCatalogModule] }).compile();
  const types = mod.get(LaasCatalog).catalog().map((e) => e.deviceType).sort();
  expect(types).toEqual(['agilent-e4402b', 'hioki-im3570', 'kronos-mux-16', 'sim-impedance', 'sim-spectrum', 'sim-temperature']);
});
