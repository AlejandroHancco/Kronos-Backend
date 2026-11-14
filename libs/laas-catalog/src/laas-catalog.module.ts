import { Module } from '@nestjs/common';
import { DEVICE_MODEL_DEFINITIONS, LaasCatalog } from './laas-catalog';
import { DEVICE_MODELS } from './models';

/** Catálogo LaaS puro (sin E/S): lo usan la API (metadata) y el worker (paridad con los drivers). */
@Module({
  providers: [{ provide: DEVICE_MODEL_DEFINITIONS, useValue: DEVICE_MODELS }, LaasCatalog],
  exports: [LaasCatalog],
})
export class LaasCatalogModule {}
