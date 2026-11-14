import { Injectable } from '@nestjs/common';
import axios from 'axios';
import raw from './service-description.json';
import { parseServiceDescription } from '../../core/service-description';
import type {
  ActuatorPlugin,
  ConfigurationValue,
  ConfigurationValues,
  ConnectionTarget,
  DeviceContext,
  DeviceServiceDescription,
} from '../../core/device-plugin.interface';

/** Validada al cargar el módulo: una descripción inválida impide el arranque. */
const DESCRIPTION = parseServiceDescription(raw, 'kronos-mux-16');

/**
 * Plugin del MUX Kronos de 16 canales: actuator selector de canal (HTTP `GET /?orden=<canal>`).
 * El MUX no permite leer el canal activo; se recuerda en memoria el último activado por Kronos.
 */
@Injectable()
export class KronosMux16Plugin implements ActuatorPlugin {
  static readonly DEVICE_TYPE = 'kronos-mux-16';

  /** Espera entre reintentos; reemplazable en tests. */
  retryDelayMs = 500;

  private readonly channels = new Map<string, number>();

  describe(): DeviceServiceDescription {
    return DESCRIPTION;
  }

  async testConnection({ ip }: ConnectionTarget): Promise<boolean> {
    if (!ip) return false;
    try {
      await axios.get(`http://${ip}`, { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  /** "setActuatorData": valida actuator y canal contra lo declarado; 3 intentos. */
  async setActuatorData(device: DeviceContext, actuatorId: string, values: Record<string, number>): Promise<void> {
    const sel = DESCRIPTION.channelSelector!;
    if (actuatorId !== sel.actuatorId) throw new Error(`Actuator desconocido "${actuatorId}" en ${KronosMux16Plugin.DEVICE_TYPE}`);
    const meta = DESCRIPTION.actuators
      .find((a) => a.actuatorId === sel.actuatorId)!
      .actuatorValues.find((v) => v.name === sel.valueName)!;
    const channel = values[sel.valueName];
    if (!Number.isInteger(channel) || channel < meta.rangeMinimum! || channel > meta.rangeMaximum!) {
      throw new Error(`Canal fuera de rango para el MUX: ${channel}`);
    }
    if (!device.ip) throw new Error(`El MUX "${device.name}" no tiene IP`);

    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Cualquier respuesta HTTP cuenta como éxito (el MUX no devuelve estado útil).
        await axios.get(`http://${device.ip}/?orden=${channel}`, { timeout: 5000, validateStatus: () => true });
        this.channels.set(device.id, channel);
        return;
      } catch (e) {
        last = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, this.retryDelayMs));
      }
    }
    const msg = last instanceof Error ? last.message : String(last);
    throw new Error(`No se pudo activar el canal ${channel} del MUX: ${msg}`);
  }

  /** Último canal activado por Kronos en este dispositivo desde que inició el backend (`null` = desconocido). */
  lastChannel(deviceId: string): number | null {
    return this.channels.get(deviceId) ?? null;
  }

  async readLiveConfiguration(device: DeviceContext): Promise<Record<string, ConfigurationValue | null>> {
    return { channel: this.lastChannel(device.id) };
  }

  async applyLiveConfiguration(device: DeviceContext, values: ConfigurationValues): Promise<void> {
    if (values.channel !== undefined) {
      await this.setActuatorData(device, DESCRIPTION.channelSelector!.actuatorId, { channel: Number(values.channel) });
    }
  }
}
