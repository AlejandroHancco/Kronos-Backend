import { Global, Module } from '@nestjs/common';
import { DevicePluginRegistry } from './core/device-plugin.registry';
import { DevicePlugin } from './core/device-plugin.interface';
import { DEVICE_PLUGIN_INSTANCES } from './core/device-plugin.tokens';
import { DEVICE_PLUGINS } from './plugins';
import { DevicePluginsController } from './device-plugins.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { ExperimentConfigService } from './core/experiment-config.service';

/**
 * Módulo del Kronos Watcher dedicado a dispositivos: registra los plugins de cada
 * tipo de dispositivo soportado (ver core/device-plugin.interface.ts). Global para que
 * DevicesModule (health check / test-connection) y MeasurementsModule (ejecución de
 * mediciones) resuelvan el mismo registry sin depender el uno del otro.
 */
@Global()
@Module({
  imports: [PrismaModule, PermissionsModule],
  controllers: [DevicePluginsController],
  providers: [
    ...DEVICE_PLUGINS,
    {
      provide: DEVICE_PLUGIN_INSTANCES,
      useFactory: (...plugins: DevicePlugin[]) => plugins,
      inject: DEVICE_PLUGINS,
    },
    DevicePluginRegistry,
    ExperimentConfigService,
  ],
  exports: [DevicePluginRegistry, ExperimentConfigService],
})
export class DevicePluginsModule {}
