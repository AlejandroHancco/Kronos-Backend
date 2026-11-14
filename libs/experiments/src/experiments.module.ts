import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { LaasCatalogModule } from '@app/laas-catalog';
import { ExperimentConfigService } from './experiment-config.service';

/** Experimento activo de una tarea (DB + catálogo puro): lo comparten la API y el ejecutor de mediciones del worker. */
@Module({
  imports: [PrismaModule, LaasCatalogModule],
  providers: [ExperimentConfigService],
  exports: [ExperimentConfigService],
})
export class ExperimentsModule {}
