import { Module } from '@nestjs/common';
import { DEVICE_DRIVERS } from './drivers';
import { DeviceDriver } from './device-driver';
import { DEVICE_DRIVER_INSTANCES, DeviceDriverRegistry } from './device-driver.registry';

/** Drivers de E/S de los dispositivos (solo el worker debería importarlo; ver `@app/laas-catalog` para la metadata). */
@Module({
  providers: [
    ...DEVICE_DRIVERS,
    {
      provide: DEVICE_DRIVER_INSTANCES,
      useFactory: (...drivers: DeviceDriver[]) => drivers,
      inject: DEVICE_DRIVERS,
    },
    DeviceDriverRegistry,
  ],
  exports: [DeviceDriverRegistry],
})
export class DeviceDriversModule {}
