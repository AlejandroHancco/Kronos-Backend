import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { DEVICE_MODEL_DEFINITIONS, LaasCatalog } from './laas-catalog';
import { DEVICE_MODELS } from './models';
import { ExperimentConfigService } from './experiment-config.service';

/**
 * Catálogo LaaS (sin E/S hacia dispositivos): lo usan la API (metadata) y el worker (paridad con los
 * drivers). ExperimentConfigService resuelve el experimento activo de una tarea (solo lectura de DB
 * + catálogo), compartido por la API y por el ejecutor de mediciones del worker.
 */
@Module({
  imports: [PrismaModule],
  providers: [{ provide: DEVICE_MODEL_DEFINITIONS, useValue: DEVICE_MODELS }, LaasCatalog, ExperimentConfigService],
  exports: [LaasCatalog, ExperimentConfigService],
})
export class LaasCatalogModule {}
