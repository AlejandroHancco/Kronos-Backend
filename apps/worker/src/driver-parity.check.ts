import { Injectable } from '@nestjs/common';
import { LaasCatalog } from '@app/laas-catalog';
import { DeviceDriverRegistry } from '@app/device-drivers';

/**
 * Comprueba que catálogo LaaS y drivers coinciden (DeviceDriverRegistry.assertParity). Lo invoca
 * main.ts justo después de NestFactory.create y antes de listen, de modo que ningún job se consume
 * (BullExplorer registra los processors al iniciar) con un modelo sin driver. Si falla, lanza
 * nombrando el modelo y main.ts termina el proceso con código 1.
 */
@Injectable()
export class DriverParityCheck {
  constructor(
    private readonly drivers: DeviceDriverRegistry,
    private readonly catalog: LaasCatalog,
  ) {}

  run(): void {
    this.drivers.assertParity(this.catalog);
  }
}
