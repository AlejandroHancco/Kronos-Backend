import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  ChannelSelectionBinding,
  DeviceConnection,
  DeviceDriverPlugin,
  DeviceServiceDescription,
} from './device-plugin.interface';
import { HiokiIm3570Plugin } from './plugins/hioki-im3570.plugin';

/**
 * Registro de plugins de dispositivo por `deviceType` (coincide con `device.type` en DB).
 * Agregar soporte para un dispositivo nuevo = crear su plugin e inyectarlo/registrarlo
 * acá; measurements.service.ts y el Kronos Watcher no cambian.
 */
export type DeviceRole = 'sensor' | 'channel-selector';

export interface DeviceTypeCatalogEntry {
  deviceType: string;
  role: DeviceRole;
  label: string;
  description: string;
  simulated: boolean;
  connection: DeviceConnection;
  channelSelection: ChannelSelectionBinding | null;
  service: DeviceServiceDescription;
}

interface Registered {
  plugin: DeviceDriverPlugin;
  role: DeviceRole;
}

@Injectable()
export class DevicePluginRegistry implements OnModuleInit {
  private readonly types = new Map<string, Registered>();

  constructor(private readonly hiokiPlugin: HiokiIm3570Plugin) {}

  onModuleInit() {
    this.register(this.hiokiPlugin);
  }

  /** Registra el tipo del plugin y, si declara selector de canal, el tipo del dispositivo que lo aloja (ej. 'mux'). */
  register(plugin: DeviceDriverPlugin): void {
    const d = plugin.describe();
    const names = d.sensors.flatMap((s) => s.sensorValues.map((v) => v.name));
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) throw new Error(`sensorValue repetido "${dup}" en el plugin "${d.deviceType}"`);
    this.add(d.deviceType, { plugin, role: 'sensor' });
    if (d.channelSelection) this.add(d.channelSelection.hostDeviceType, { plugin, role: 'channel-selector' });
  }

  private add(type: string, entry: Registered) {
    if (this.types.has(type)) throw new Error(`Tipo de dispositivo duplicado: "${type}"`);
    this.types.set(type, entry);
  }

  get(deviceType: string | null | undefined): DeviceDriverPlugin {
    const entry = deviceType ? this.types.get(deviceType) : undefined;
    if (!entry) {
      throw new NotFoundException(
        `No hay un device plugin registrado para el tipo "${deviceType}"`,
      );
    }
    return entry.plugin;
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

  catalog(): DeviceTypeCatalogEntry[] {
    return [...this.types.entries()].map(([deviceType, { plugin, role }]) => {
      const service = plugin.describe();
      if (role === 'sensor') {
        return {
          deviceType,
          role,
          label: service.fullName,
          description: service.description,
          simulated: service.simulated,
          connection: service.connection,
          channelSelection: service.channelSelection ?? null,
          service,
        };
      }
      const binding = service.channelSelection!;
      const actuator = service.actuators.find((a) => a.actuatorId === binding.actuatorId);
      return {
        deviceType,
        role,
        label: `${binding.hostLabel} (${service.fullName})`,
        description: actuator?.description ?? '',
        simulated: service.simulated,
        connection: binding.connection,
        channelSelection: null,
        service,
      };
    });
  }
}
