import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { Device, Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
// Intermedio: la E/S de configuración live pasa al worker (device-ops) en tareas posteriores.
import { DeviceDriverRegistry } from '@app/device-drivers';
import { DeviceStateService } from '@app/redis';
import {
  ConfigurationParameterMetadata,
  ConfigurationValue,
  ConfigurationValues,
  LaasCatalog,
  configurationPatchErrors,
  effectiveConfiguration,
  parameterValueError,
  splitPatch,
  toDeviceContext,
} from '@app/laas-catalog';

export type ConfigurationParameterView = ConfigurationParameterMetadata & { value: ConfigurationValue | null };

/** getConfiguration (extensión Kronos): parámetros declarados con su valor actual. */
export interface DeviceConfigurationView {
  deviceId: string;
  deviceType: string;
  busy: boolean;
  parameters: ConfigurationParameterView[];
}

/**
 * getConfiguration / setConfiguration por dispositivo. Los parámetros 'persisted' se guardan en
 * `devices.configuration`; los 'live' los aplica el driver en el dispositivo y nunca se guardan;
 * los 'fixed' solo existen en la service description.
 */
@Injectable()
export class DeviceConfigurationService {
  constructor(
    private prisma: PrismaService,
    private catalog: LaasCatalog,
    private drivers: DeviceDriverRegistry,
    private deviceState: DeviceStateService,
  ) {}

  async view(device: Device): Promise<DeviceConfigurationView> {
    const description = this.catalog.describe(device.type);
    const params = description.configuration;
    const effective = effectiveConfiguration(params, device.configuration);
    let live: Record<string, ConfigurationValue | null> = {};
    if (params.some((p) => p.storage === 'live')) {
      try {
        const driver = this.drivers.get(device.type);
        if (driver.readLiveConfiguration) live = await driver.readLiveConfiguration(toDeviceContext(device, description));
      } catch {
        live = {};
      }
    }
    return {
      deviceId: device.id,
      deviceType: description.deviceType,
      busy: await this.deviceState.isBusy(device.id),
      parameters: params.map((p) => ({ ...p, value: (p.storage === 'live' ? live[p.name] : effective[p.name]) ?? null })),
    };
  }

  async apply(device: Device, values: Record<string, unknown>): Promise<DeviceConfigurationView> {
    const description = this.catalog.describe(device.type);
    const params = description.configuration;
    if (device.status === 'archived') throw new BadRequestException('No se puede configurar un dispositivo archivado');

    const errors = configurationPatchErrors(params, values);
    if (errors.length) throw new BadRequestException(errors.join('; '));
    const { persisted, live } = splitPatch(params, values as ConfigurationValues);

    const crossFieldError = this.catalog.validateConfiguration(device.type, { ...effectiveConfiguration(params, device.configuration), ...persisted });
    if (crossFieldError) throw new BadRequestException(crossFieldError);

    const hasLive = Object.keys(live).length > 0;
    if (hasLive && description.connection.requiresIp && !device.ip) {
      throw new BadRequestException(`"${device.name}" no tiene IP configurada`);
    }

    const updated = await this.deviceState.withExclusive(device, async () => {
      if (hasLive) {
        try {
          await this.drivers.get(device.type).applyLiveConfiguration!(toDeviceContext(device, description), live);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new BadGatewayException(`No se pudo aplicar la configuración en "${device.name}": ${msg}`);
        }
      }
      if (Object.keys(persisted).length === 0) return device;
      return this.prisma.device.update({
        where: { id: device.id },
        data: { configuration: { ...this.validStored(params, device.configuration), ...persisted } as Prisma.InputJsonValue },
      });
    });
    return this.view(updated);
  }

  /** Valores guardados que siguen siendo parámetros 'persisted' válidos (descarta claves viejas o inválidas). */
  private validStored(params: ConfigurationParameterMetadata[], stored: unknown): ConfigurationValues {
    const obj = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
    const result: ConfigurationValues = {};
    for (const p of params) {
      if (p.storage === 'persisted' && obj[p.name] !== undefined && parameterValueError(p, obj[p.name]) === null) {
        result[p.name] = obj[p.name] as ConfigurationValue;
      }
    }
    return result;
  }
}
