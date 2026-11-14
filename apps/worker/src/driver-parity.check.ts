import { Injectable, OnModuleInit } from '@nestjs/common';
import { LaasCatalog } from '@app/laas-catalog';
import { DeviceDriverRegistry } from '@app/device-drivers';

/**
 * Al arrancar el worker comprueba que catálogo LaaS y drivers coinciden
 * (DeviceDriverRegistry.assertParity). Si no, la inicialización falla nombrando el modelo
 * y main.ts termina el proceso con código 1.
 */
@Injectable()
export class DriverParityCheck implements OnModuleInit {
  constructor(
    private readonly drivers: DeviceDriverRegistry,
    private readonly catalog: LaasCatalog,
  ) {}

  onModuleInit(): void {
    this.drivers.assertParity(this.catalog);
  }
}
