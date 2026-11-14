import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Device, Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { DeviceStateService } from '@app/redis';
import { DeviceOpsClient } from '@app/queue';
import {
  ConfigurationParameterMetadata,
  ConfigurationValue,
  ConfigurationValues,
  LaasCatalog,
  configurationPatchErrors,
  effectiveConfiguration,
  parameterValueError,
  splitPatch,
} from '@app/laas-catalog';
import { deviceOpTimeoutMs, mapDeviceOpError } from './device-op-errors';

const busyMessage = (name: string) => `"${name}" está midiendo; espera a que termine para cambiar su configuración`;

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
 * `devices.configuration`; los 'live' los aplica el worker (cola device-ops) en el dispositivo y nunca se guardan;
 * los 'fixed' solo existen en la service description.
 */
@Injectable()
export class DeviceConfigurationService {
  constructor(
    private prisma: PrismaService,
    private catalog: LaasCatalog,
    private deviceState: DeviceStateService,
    private deviceOps: DeviceOpsClient,
  ) {}

  async view(device: Device): Promise<DeviceConfigurationView> {
    const description = this.catalog.describe(device.type);
    const params = description.configuration;
    const effective = effectiveConfiguration(params, device.configuration);
    let live: Record<string, ConfigurationValue | null> = {};
    if (params.some((p) => p.storage === 'live')) {
      try {
        live = (await this.deviceOps.request<Record<string, ConfigurationValue | null> | null>(
          'read-live-configuration',
          { deviceId: device.id },
          deviceOpTimeoutMs(),
        )) ?? {};
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

    if (hasLive) {
      // Camino rápido: el 409 definitivo lo da el worker (withExclusive) al ejecutar la operación.
      if (await this.deviceState.isBusy(device.id)) throw new ConflictException(busyMessage(device.name));
      try {
        await this.deviceOps.request('apply-live-configuration', { deviceId: device.id, values: live }, deviceOpTimeoutMs());
      } catch (e) {
        throw mapDeviceOpError(e, device.name);
      }
    }
    // La parte persistida solo se guarda si la live tuvo éxito; con el lock para que una medición
    // que arranca a la vez lo vea.
    const updated =
      Object.keys(persisted).length === 0
        ? device
        : await this.deviceState.withExclusive(device, () =>
            this.prisma.device.update({
              where: { id: device.id },
              data: { configuration: { ...this.validStored(params, device.configuration), ...persisted } as Prisma.InputJsonValue },
            }),
          );
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
