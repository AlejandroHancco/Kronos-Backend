import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { LaasCatalog } from '@app/laas-catalog';
import { ActuatorDriver, DeviceDriver, SensorDriver, isActuatorDriver, isSensorDriver } from './device-driver';

/** DI token para la lista de instancias de driver (ver drivers/index.ts y device-drivers.module.ts). */
export const DEVICE_DRIVER_INSTANCES = Symbol('DEVICE_DRIVER_INSTANCES');

/**
 * Registro de drivers de E/S por `deviceType`. Solo el worker debería cargarlo; la metadata
 * (roles, descripciones) la da `LaasCatalog`. `assertParity` comprueba que catálogo y drivers
 * coinciden y que cada driver implementa lo que su descripción declara.
 */
@Injectable()
export class DeviceDriverRegistry {
  private readonly drivers = new Map<string, DeviceDriver>();

  constructor(@Inject(DEVICE_DRIVER_INSTANCES) drivers: DeviceDriver[]) {
    for (const d of drivers) {
      if (this.drivers.has(d.deviceType)) throw new Error(`Tipo de dispositivo duplicado: "${d.deviceType}"`);
      this.drivers.set(d.deviceType, d);
    }
  }

  has(deviceType: string | null | undefined): boolean {
    return !!deviceType && this.drivers.has(deviceType);
  }

  get(deviceType: string | null | undefined): DeviceDriver {
    const driver = deviceType ? this.drivers.get(deviceType) : undefined;
    if (!driver) throw new NotFoundException(`No hay un device plugin registrado para ${deviceType ? `el tipo "${deviceType}"` : 'un dispositivo sin tipo'}`);
    return driver;
  }

  /** Driver con "getSensorData". */
  sensor(deviceType: string | null | undefined): SensorDriver {
    const driver = this.get(deviceType);
    if (!isSensorDriver(driver)) throw new NotFoundException(`El tipo "${deviceType}" no es un equipo de medición`);
    return driver;
  }

  /** Driver con "setActuatorData" (hoy: selector de canal). */
  actuator(deviceType: string | null | undefined): ActuatorDriver {
    const driver = this.get(deviceType);
    if (!isActuatorDriver(driver)) throw new NotFoundException(`El tipo "${deviceType}" no es un selector de canal`);
    return driver;
  }

  /**
   * Falla (con todos los problemas a la vez) si algún modelo del catálogo no tiene driver o viceversa,
   * o si un driver no implementa lo que declara su descripción: sensores → getSensorData,
   * channelSelector → setActuatorData, parámetros live → applyLiveConfiguration.
   */
  assertParity(catalog: LaasCatalog): void {
    const problems: string[] = [];
    const described = new Set<string>();
    for (const { deviceType, role, service } of catalog.catalog()) {
      described.add(deviceType);
      const where = `Plugin "${deviceType}"`;
      const driver = this.drivers.get(deviceType);
      if (!driver) {
        problems.push(`${where}: tiene descripción en el catálogo pero está sin driver`);
        continue;
      }
      if (role === 'sensor' && !isSensorDriver(driver)) problems.push(`${where}: declara sensores pero no implementa getSensorData`);
      if (role === 'channel-selector' && !isActuatorDriver(driver)) {
        problems.push(`${where}: declara channelSelector pero no implementa setActuatorData`);
      }
      if (service.configuration.some((p) => p.storage === 'live') && typeof driver.applyLiveConfiguration !== 'function') {
        problems.push(`${where}: declara parámetros live pero no implementa applyLiveConfiguration`);
      }
    }
    for (const deviceType of this.drivers.keys()) {
      if (!described.has(deviceType)) problems.push(`Plugin "${deviceType}": tiene driver pero está sin descripción en el catálogo`);
    }
    if (problems.length) throw new Error(`Catálogo LaaS y drivers no coinciden:\n${problems.join('\n')}`);
  }
}
