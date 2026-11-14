import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ConfigurationParameterMetadata,
  ConfigurationValues,
  DeviceConnection,
  DeviceModelDefinition,
  DeviceRole,
  DeviceServiceDescription,
} from './contract';
import { AcquisitionMetadata, acquisitionOf } from './acquisition';
import { ChannelRange, channelRangeOf } from './experiment-config';

export type { DeviceRole } from './contract';

/** DI token para la lista de modelos del catálogo (ver models/index.ts y laas-catalog.module.ts). */
export const DEVICE_MODEL_DEFINITIONS = Symbol('DEVICE_MODEL_DEFINITIONS');

export interface DeviceTypeCatalogEntry {
  deviceType: string;
  role: DeviceRole;
  /** fullName */
  label: string;
  shortName: string;
  manufacturer: string;
  description: string;
  simulated: boolean;
  connection: DeviceConnection;
  /** Solo para 'channel-selector': rango declarado por su actuator. */
  channelRange: ChannelRange | null;
  configuration: ConfigurationParameterMetadata[];
  /** Solo para 'sensor': adquisición declarada por su primer sensor. */
  acquisition: AcquisitionMetadata | null;
  service: DeviceServiceDescription;
}

/** Qué actuator/valor de un selector de canal elige el canal, y su rango declarado. */
export interface ChannelSelectorBinding {
  actuatorId: string;
  valueName: string;
  range: ChannelRange;
}

interface Registered {
  model: DeviceModelDefinition;
  role: DeviceRole;
}

/**
 * Rol de un modelo según su descripción (puro, sin mirar código de E/S):
 *   - 'sensor': declara sensores;
 *   - 'channel-selector': declara channelSelector;
 *   - ambos o ninguno: error.
 * Que el driver implemente la capacidad declarada lo comprueba `DeviceDriverRegistry.assertParity`.
 */
export function roleOf(d: DeviceServiceDescription): DeviceRole {
  const where = `Plugin "${d.deviceType}"`;
  const isSensor = d.sensors.length > 0;
  const isSelector = !!d.channelSelector;
  if (isSensor && isSelector) throw new Error(`${where}: no puede ser sensor y selector de canal a la vez`);
  if (!isSensor && !isSelector) throw new Error(`${where}: no declara sensores ni un selector de canal`);
  return isSensor ? 'sensor' : 'channel-selector';
}

/**
 * Catálogo LaaS de modelos de dispositivo por `deviceType` (coincide con `device.type` en DB).
 * Solo metadata: service descriptions, roles, experimentos y validación de configuración.
 * No carga ningún código que hable con los dispositivos (eso es `@app/device-drivers`).
 * Un modelo inválido impide el arranque.
 */
@Injectable()
export class LaasCatalog {
  private readonly types = new Map<string, Registered>();

  constructor(@Inject(DEVICE_MODEL_DEFINITIONS) models: DeviceModelDefinition[]) {
    models.forEach((m) => this.register(m));
  }

  private register(model: DeviceModelDefinition): void {
    const d = model.description;
    if (this.types.has(d.deviceType)) throw new Error(`Tipo de dispositivo duplicado: "${d.deviceType}"`);
    this.types.set(d.deviceType, { model, role: roleOf(d) });
  }

  private entry(deviceType: string | null | undefined): Registered {
    const entry = deviceType ? this.types.get(deviceType) : undefined;
    if (!entry) throw new NotFoundException(`No hay un device plugin registrado para ${deviceType ? `el tipo "${deviceType}"` : 'un dispositivo sin tipo'}`);
    return entry;
  }

  has(deviceType: string | null | undefined): boolean {
    return !!deviceType && this.types.has(deviceType);
  }

  role(deviceType: string | null | undefined): DeviceRole | undefined {
    return deviceType ? this.types.get(deviceType)?.role : undefined;
  }

  describe(deviceType: string | null | undefined): DeviceServiceDescription {
    return this.entry(deviceType).model.description;
  }

  channelSelector(deviceType: string | null | undefined): ChannelSelectorBinding {
    const { model, role } = this.entry(deviceType);
    const d = model.description;
    const range = channelRangeOf(d);
    if (role !== 'channel-selector' || !d.channelSelector || !range) {
      throw new NotFoundException(`El tipo "${deviceType}" no es un selector de canal`);
    }
    return { actuatorId: d.channelSelector.actuatorId, valueName: d.channelSelector.valueName, range };
  }

  /** Reglas entre campos del modelo sobre la configuración efectiva; `null` si es válida o no declara reglas. */
  validateConfiguration(deviceType: string | null | undefined, effective: ConfigurationValues): string | null {
    return this.entry(deviceType).model.validateConfiguration?.(effective) ?? null;
  }

  catalog(): DeviceTypeCatalogEntry[] {
    return [...this.types.entries()].map(([deviceType, { model, role }]) => {
      const d = model.description;
      return {
        deviceType,
        role,
        label: d.fullName,
        shortName: d.shortName,
        manufacturer: d.manufacturer,
        description: d.description,
        simulated: d.simulated,
        connection: d.connection,
        channelRange: role === 'channel-selector' ? channelRangeOf(d) : null,
        configuration: d.configuration,
        acquisition: acquisitionOf(d),
        service: d,
      };
    });
  }
}
