import { Global, Module } from '@nestjs/common';
import { LaasCatalogModule } from '@app/laas-catalog';
import { ExperimentsModule } from '@app/experiments';
// Intermedio: la API aún hace E/S (medición, test-connection, configuración live) hasta que pase al worker.
import { DeviceDriversModule } from '@app/device-drivers';
import { DevicePluginsController } from './device-plugins.controller';
import { PrismaModule } from '@app/database';
import { PermissionsModule } from '../permissions/permissions.module';
import { ExperimentCatalogService } from './core/experiment-catalog.service';
import { ExperimentsController, ProjectExperimentsController } from './core/experiments.controller';
import { CommonModule } from '@app/common';

/**
 * Módulo del Kronos Watcher dedicado a dispositivos: expone el catálogo LaaS (`@app/laas-catalog`,
 * metadata pura) y, por ahora, los drivers de E/S (`@app/device-drivers`). Global para que
 * DevicesModule (health check / test-connection) y MeasurementsModule (ejecución de
 * mediciones) resuelvan los mismos LaasCatalog y DeviceDriverRegistry sin depender el uno del otro.
 */
@Global()
@Module({
  imports: [PrismaModule, PermissionsModule, CommonModule, LaasCatalogModule, ExperimentsModule, DeviceDriversModule],
  controllers: [DevicePluginsController, ExperimentsController, ProjectExperimentsController],
  providers: [
    ExperimentCatalogService,
  ],
  exports: [
    LaasCatalogModule,
    ExperimentsModule,
    DeviceDriversModule,
    ExperimentCatalogService,
  ],
})
export class DevicePluginsModule {}
