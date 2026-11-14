import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import type { Device } from '@prisma/client';
import { PrismaService } from '@app/database';
import { DeviceDriverRegistry } from '@app/device-drivers';
import {
  ConfigurationValue,
  ConfigurationValues,
  DeviceServiceDescription,
  LaasCatalog,
  actuatorMissingMessage,
  actuatorValuesError,
  toDeviceContext,
} from '@app/laas-catalog';
import {
  ApplyLiveConfigurationJob,
  DEVICE_OPS_QUEUE,
  DeviceOpData,
  ReadLiveConfigurationJob,
  SetActuatorDataJob,
  TestConnectionJob,
} from '@app/queue';
import { DeviceStateService, LiveValueStore } from '@app/redis';
import { DeviceReachability } from '../devices/device-reachability';

/** Valores de `values` que coinciden con un parámetro 'live' declarado (los que se registran en el ledger). */
function liveSubset(description: DeviceServiceDescription, values: Record<string, ConfigurationValue>): ConfigurationValues {
  const live = new Set(description.configuration.filter((p) => p.storage === 'live').map((p) => p.name));
  return Object.fromEntries(Object.entries(values).filter(([name]) => live.has(name)));
}

/**
 * Procesador de la cola 'device-ops': operaciones cortas sobre dispositivos pedidas por la API
 * (que nunca abre conexiones al laboratorio). Un único handler '*' con concurrencia 5 para toda la
 * cola. Las operaciones que cambian el estado del equipo toman el lock del dispositivo
 * (DeviceStateService.withExclusive): si está ocupado (midiendo o configurándose) fallan con el texto del 409, que la API
 * reconoce en el failedReason del job (mapDeviceOpError).
 */
@Processor(DEVICE_OPS_QUEUE)
export class DeviceOpsProcessor {
  private readonly logger = new Logger(DeviceOpsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: LaasCatalog,
    private readonly drivers: DeviceDriverRegistry,
    private readonly deviceState: DeviceStateService,
    private readonly liveValues: LiveValueStore,
    private readonly reachability: DeviceReachability,
  ) {}

  @Process({ name: '*', concurrency: 5 })
  async handle(job: Job<DeviceOpData>): Promise<unknown> {
    switch (job.name) {
      case 'test-connection':
        return this.testConnection(job.data as TestConnectionJob);
      case 'read-live-configuration':
        return this.readLiveConfiguration(job.data as ReadLiveConfigurationJob);
      case 'apply-live-configuration':
        return this.applyLiveConfiguration(job.data as ApplyLiveConfigurationJob);
      case 'set-actuator-data':
        return this.setActuatorData(job.data as SetActuatorDataJob);
      default:
        throw new Error(`Operación de dispositivo desconocida: "${job.name}"`);
    }
  }

  /** La API manda ip '' (tipos sin IP) y port 0 (sin puerto): se normalizan a null / puerto por defecto. */
  private testConnection({ type, ip, port }: TestConnectionJob): Promise<boolean> {
    return this.reachability.check(type, ip || null, port || undefined);
  }

  /** Por parámetro live: valor leído del equipo (si el driver puede y no es null), si no el ledger, si no null. */
  private async readLiveConfiguration({ deviceId }: ReadLiveConfigurationJob): Promise<Record<string, ConfigurationValue | null>> {
    const device = await this.findDevice(deviceId);
    const description = this.catalog.describe(device.type);
    const names = description.configuration.filter((p) => p.storage === 'live').map((p) => p.name);
    if (names.length === 0) return {};

    const driver = this.drivers.get(device.type);
    let fromDevice: Record<string, ConfigurationValue | null> = {};
    if (typeof driver.readLiveConfiguration === 'function') {
      try {
        fromDevice = await driver.readLiveConfiguration(toDeviceContext(device, description));
      } catch (err) {
        this.logger.warn(`readLiveConfiguration de ${deviceId} falló; se usa el último valor registrado: ${(err as Error).message}`);
      }
    }
    const recorded = await this.liveValues.read(deviceId);
    return Object.fromEntries(names.map((n) => [n, fromDevice[n] ?? recorded[n] ?? null]));
  }

  private async applyLiveConfiguration({ deviceId, values }: ApplyLiveConfigurationJob): Promise<true> {
    const device = await this.findDevice(deviceId);
    const description = this.catalog.describe(device.type);
    const driver = this.drivers.get(device.type);
    if (typeof driver.applyLiveConfiguration !== 'function') {
      throw new BadRequestException(`"${device.name}" no admite configuración live`);
    }
    await this.deviceState.withExclusive(device, async () => {
      await driver.applyLiveConfiguration!(toDeviceContext(device, description), values);
      await this.liveValues.record(device.id, values);
    });
    return true;
  }

  private async setActuatorData({ deviceId, actuatorId, values }: SetActuatorDataJob): Promise<true> {
    const device = await this.findDevice(deviceId);
    const description = this.catalog.describe(device.type);
    const actuator = description.actuators.find((a) => a.actuatorId === actuatorId);
    if (!actuator) throw new BadRequestException(actuatorMissingMessage(device.name, actuatorId));
    // Rangos y paso declarados (IEEE 1876 §4.4.1); la API reconoce estos mensajes y responde 400.
    const invalid = actuatorValuesError(actuator, values ?? {});
    if (invalid) throw new BadRequestException(invalid);
    const driver = this.drivers.actuator(device.type);
    await this.deviceState.withExclusive(device, async () => {
      await driver.setActuatorData(toDeviceContext(device, description), actuatorId, values);
      const live = liveSubset(description, values);
      if (Object.keys(live).length) await this.liveValues.record(device.id, live);
    });
    return true;
  }

  private async findDevice(deviceId: string): Promise<Device> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundException(`Dispositivo ${deviceId} no encontrado`);
    return device;
  }
}
