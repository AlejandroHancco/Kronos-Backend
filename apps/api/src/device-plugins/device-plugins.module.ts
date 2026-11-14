import { Global, Module } from '@nestjs/common';
import { LaasCatalogModule } from '@app/laas-catalog';
import { ExperimentsModule } from '@app/experiments';
import { DevicePluginsController } from './device-plugins.controller';
import { PrismaModule } from '@app/database';
import { PermissionsModule } from '../permissions/permissions.module';
import { ExperimentCatalogService } from './core/experiment-catalog.service';
import { ExperimentsController, ProjectExperimentsController } from './core/experiments.controller';
import { CommonModule } from '@app/common';

/**
 * Módulo del Kronos Watcher dedicado a dispositivos: expone el catálogo LaaS (`@app/laas-catalog`,
 * metadata pura) y la configuración de experimentos. Global para que los demás módulos resuelvan el
 * mismo LaasCatalog. Los drivers de E/S (`@app/device-drivers`) solo los carga el worker.
 */
@Global()
@Module({
  imports: [PrismaModule, PermissionsModule, CommonModule, LaasCatalogModule, ExperimentsModule],
  controllers: [DevicePluginsController, ExperimentsController, ProjectExperimentsController],
  providers: [
    ExperimentCatalogService,
  ],
  exports: [
    LaasCatalogModule,
    ExperimentsModule,
    ExperimentCatalogService,
  ],
})
export class DevicePluginsModule {}
