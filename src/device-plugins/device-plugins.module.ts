import { Global, Module } from '@nestjs/common';
import { DevicePluginRegistry } from './core/device-plugin.registry';
import { DevicePlugin } from './core/device-plugin.interface';
import { DEVICE_PLUGIN_INSTANCES } from './core/device-plugin.tokens';
import { DEVICE_PLUGINS } from './plugins';
import { DevicePluginsController } from './device-plugins.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { ExperimentConfigService } from './core/experiment-config.service';
import { ExperimentCatalogService } from './core/experiment-catalog.service';
import { ExperimentsController, ProjectExperimentsController } from './core/experiments.controller';
import { CommonModule } from '../common/common.module';

/**
 * Módulo del Kronos Watcher dedicado a dispositivos: registra los plugins de cada
 * tipo de dispositivo soportado (ver core/device-plugin.interface.ts). Global para que
 * DevicesModule (health check / test-connection) y MeasurementsModule (ejecución de
 * mediciones) resuelvan el mismo registry sin depender el uno del otro.
 */
@Global()
@Module({
  imports: [PrismaModule, PermissionsModule, CommonModule],
  controllers: [DevicePluginsController, ExperimentsController, ProjectExperimentsController],
  providers: [
    ...DEVICE_PLUGINS,
    {
      provide: DEVICE_PLUGIN_INSTANCES,
      useFactory: (...plugins: DevicePlugin[]) => plugins,
      inject: DEVICE_PLUGINS,
    },
    DevicePluginRegistry,
    ExperimentConfigService,
    ExperimentCatalogService,
  ],
  exports: [DevicePluginRegistry, ExperimentConfigService, ExperimentCatalogService],
})
export class DevicePluginsModule {}
