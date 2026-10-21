import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ActuatorPlugin,
  ConfigurationParameterMetadata,
  DeviceConnection,
  DevicePlugin,
  DeviceRole,
  DeviceServiceDescription,
  SensorPlugin,
  isActuatorPlugin,
  isSensorPlugin,
} from './device-plugin.interface';
import { DEVICE_PLUGIN_INSTANCES } from './device-plugin.tokens';
import { ChannelRange, channelRangeOf } from './experiment-config';

export type { DeviceRole } from './device-plugin.interface';

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
  service: DeviceServiceDescription;
}

export interface ChannelSelectorBinding {
  plugin: ActuatorPlugin;
  actuatorId: string;
  valueName: string;
  range: ChannelRange;
}

interface Registered {
  plugin: DevicePlugin;
  role: DeviceRole;
}

/**
 * Rol de un plugin según lo que declara y lo que implementa (puro):
 *   - 'sensor': declara sensores e implementa getSensorData;
 *   - 'channel-selector': declara channelSelector e implementa setActuatorData;
 *   - ambos o ninguno: error. Parámetros 'live' exigen read/applyLiveConfiguration.
 */
export function roleOf(plugin: DevicePlugin, d: DeviceServiceDescription): DeviceRole {
  const where = `Plugin "${d.deviceType}"`;
  const isSensor = d.sensors.length > 0;
  const isSelector = !!d.channelSelector;
  if (isSensor && isSelector) throw new Error(`${where}: no puede ser sensor y selector de canal a la vez`);
  if (!isSensor && !isSelector) throw new Error(`${where}: no declara sensores ni un selector de canal`);
  if (isSensor && !isSensorPlugin(plugin)) throw new Error(`${where}: declara sensores pero no implementa getSensorData`);
  if (isSelector && !isActuatorPlugin(plugin)) {
    throw new Error(`${where}: declara channelSelector pero no implementa setActuatorData`);
  }
  const hasLive = d.configuration.some((p) => p.storage === 'live');
  if (hasLive && (typeof plugin.readLiveConfiguration !== 'function' || typeof plugin.applyLiveConfiguration !== 'function')) {
    throw new Error(`${where}: declara parámetros live pero no implementa readLiveConfiguration y applyLiveConfiguration`);
  }
  return isSensor ? 'sensor' : 'channel-selector';
}

/**
 * Registro de plugins por `deviceType` (coincide con `device.type` en DB, un id de modelo).
 * Los plugins llegan por DI desde plugins/index.ts; un plugin inválido impide el arranque.
 */
@Injectable()
export class DevicePluginRegistry {
  private readonly types = new Map<string, Registered>();

  constructor(@Inject(DEVICE_PLUGIN_INSTANCES) plugins: DevicePlugin[]) {
    plugins.forEach((p) => this.register(p));
  }

  register(plugin: DevicePlugin): void {
    const d = plugin.describe();
    if (this.types.has(d.deviceType)) throw new Error(`Tipo de dispositivo duplicado: "${d.deviceType}"`);
    this.types.set(d.deviceType, { plugin, role: roleOf(plugin, d) });
  }

  private entry(deviceType: string | null | undefined): Registered {
    const entry = deviceType ? this.types.get(deviceType) : undefined;
    if (!entry) throw new NotFoundException(`No hay un device plugin registrado para el tipo "${deviceType}"`);
    return entry;
  }

  get(deviceType: string | null | undefined): DevicePlugin {
    return this.entry(deviceType).plugin;
  }

  has(deviceType: string | null | undefined): boolean {
    return !!deviceType && this.types.has(deviceType);
  }

  role(deviceType: string | null | undefined): DeviceRole | undefined {
    return deviceType ? this.types.get(deviceType)?.role : undefined;
  }

  describe(deviceType: string): DeviceServiceDescription {
    return this.get(deviceType).describe();
  }

  sensor(deviceType: string | null | undefined): SensorPlugin {
    const { plugin, role } = this.entry(deviceType);
    if (role !== 'sensor' || !isSensorPlugin(plugin)) {
      throw new NotFoundException(`El tipo "${deviceType}" no es un equipo de medición`);
    }
    return plugin;
  }

  channelSelector(deviceType: string | null | undefined): ChannelSelectorBinding {
    const { plugin, role } = this.entry(deviceType);
    const d = plugin.describe();
    const range = channelRangeOf(d);
    if (role !== 'channel-selector' || !isActuatorPlugin(plugin) || !d.channelSelector || !range) {
      throw new NotFoundException(`El tipo "${deviceType}" no es un selector de canal`);
    }
    return { plugin, actuatorId: d.channelSelector.actuatorId, valueName: d.channelSelector.valueName, range };
  }

  catalog(): DeviceTypeCatalogEntry[] {
    return [...this.types.entries()].map(([deviceType, { plugin, role }]) => {
      const d = plugin.describe();
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
        service: d,
      };
    });
  }
}
