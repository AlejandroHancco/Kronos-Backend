import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/database';
import { QueueModule } from '@app/queue';
import { DevicesModule } from '../devices/devices.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { LaasMetadataController } from './laas-metadata.controller';
import { LaasSensorsController } from './laas-sensors.controller';
import { LaasActuatorsController } from './laas-actuators.controller';
import { LaasConfigurationController } from './laas-configuration.controller';
import { LaasExperimentsController } from './laas-experiments.controller';
import { LaasMetadataService } from './laas-metadata.service';
import { LaasInstancesService } from './laas-instances.service';

/** Controllers de /laas/v1 (el spec de rutas ↔ metadatos los recorre). */
export const LAAS_CONTROLLERS = [
  LaasMetadataController,
  LaasSensorsController,
  LaasActuatorsController,
  LaasConfigurationController,
  LaasExperimentsController,
];

/**
 * Capa de servicios IEEE 1876-2019 §4 (Lab as a Service) en /laas/v1. Metadatos desde el catálogo
 * (`@app/laas-catalog`); la E/S con los equipos la delega en el worker (DeviceOpsClient) y las
 * mediciones en la admisión existente (MeasurementSchedulingService).
 */
@Module({
  imports: [PrismaModule, QueueModule, DevicesModule, SchedulerModule],
  controllers: LAAS_CONTROLLERS,
  providers: [LaasMetadataService, LaasInstancesService],
})
export class LaasModule {}
