import { Global, Module } from '@nestjs/common';
import { DevicePluginRegistry } from './device-plugin.registry';
import { HiokiIm3570Plugin } from './plugins/hioki-im3570.plugin';
import { SimulatedImpedancePlugin } from './plugins/simulated-impedance.plugin';
import { DevicePluginsController } from './device-plugins.controller';

/**
 * Módulo del Kronos Watcher dedicado a dispositivos: registra los plugins de cada
 * tipo de dispositivo soportado (ver device-plugin.interface.ts). Global para que
 * DevicesModule (health check / test-connection) y MeasurementsModule (ejecución de
 * mediciones) resuelvan el mismo registry sin depender el uno del otro.
 */
@Global()
@Module({
  controllers: [DevicePluginsController],
  providers: [HiokiIm3570Plugin, SimulatedImpedancePlugin, DevicePluginRegistry],
  exports: [DevicePluginRegistry],
})
export class DevicePluginsModule {}
