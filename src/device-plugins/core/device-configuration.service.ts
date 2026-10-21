import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { Device, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DevicePluginRegistry } from './device-plugin.registry';
import { DeviceActivityService } from './device-activity.service';
import type { ConfigurationParameterMetadata, ConfigurationValue, ConfigurationValues } from './device-plugin.interface';
import {
  configurationPatchErrors,
  effectiveConfiguration,
  parameterValueError,
  splitPatch,
  toDeviceContext,
} from './configuration';

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
 * `devices.configuration`; los 'live' los aplica el plugin en el dispositivo y nunca se guardan;
 * los 'fixed' solo existen en la service description.
 */
@Injectable()
export class DeviceConfigurationService {
  constructor(
    private prisma: PrismaService,
    private registry: DevicePluginRegistry,
    private deviceActivity: DeviceActivityService,
  ) {}

  async view(device: Device): Promise<DeviceConfigurationView> {
    const plugin = this.registry.get(device.type);
    const description = plugin.describe();
    const params = description.configuration;
    const effective = effectiveConfiguration(params, device.configuration);
    let live: Record<string, ConfigurationValue | null> = {};
    if (params.some((p) => p.storage === 'live') && plugin.readLiveConfiguration) {
      try {
        live = await plugin.readLiveConfiguration(toDeviceContext(device, description));
      } catch {
        live = {};
      }
    }
    return {
      deviceId: device.id,
      deviceType: description.deviceType,
      busy: await this.deviceActivity.isBusy(device.id),
      parameters: params.map((p) => ({ ...p, value: (p.storage === 'live' ? live[p.name] : effective[p.name]) ?? null })),
    };
  }

  async apply(device: Device, values: Record<string, unknown>): Promise<DeviceConfigurationView> {
    const plugin = this.registry.get(device.type);
    const description = plugin.describe();
    const params = description.configuration;
    if (device.status === 'archived') throw new BadRequestException('No se puede configurar un dispositivo archivado');

    const errors = configurationPatchErrors(params, values);
    if (errors.length) throw new BadRequestException(errors.join('; '));
    const { persisted, live } = splitPatch(params, values as ConfigurationValues);

    const crossFieldError = plugin.validateConfiguration?.({ ...effectiveConfiguration(params, device.configuration), ...persisted });
    if (crossFieldError) throw new BadRequestException(crossFieldError);

    const hasLive = Object.keys(live).length > 0;
    if (hasLive && description.connection.requiresIp && !device.ip) {
      throw new BadRequestException(`"${device.name}" no tiene IP configurada`);
    }

    const updated = await this.deviceActivity.runConfiguration(device, async () => {
      if (hasLive) {
        try {
          await plugin.applyLiveConfiguration!(toDeviceContext(device, description), live);
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
