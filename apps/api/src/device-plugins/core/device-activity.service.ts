import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { runningJobDeviceIds } from '../../scheduler/device-usage';

/**
 * Actividad de los dispositivos dentro de este proceso: qué dispositivos están midiendo y cuáles
 * tienen un cambio de configuración en curso. Una medición espera a que termine la configuración en
 * curso; una configuración se rechaza (409) si el dispositivo está midiendo o tiene un job programado
 * 'running'. Supone un único proceso Node (el processor de Bull y el fallback viven en la API).
 */
@Injectable()
export class DeviceActivityService {
  private readonly measuring = new Map<string, number>();
  private readonly configuring = new Map<string, Promise<void>>();

  constructor(private prisma: PrismaService) {}

  /** Marca los dispositivos como midiendo; devuelve un `release` idempotente. */
  async beginMeasurement(ids: string[]): Promise<() => void> {
    // Otra configuración puede empezar mientras se espera la anterior: esperar hasta que no quede ninguna.
    while (ids.some((id) => this.configuring.has(id))) {
      await Promise.allSettled(ids.map((id) => this.configuring.get(id)).filter((p): p is Promise<void> => !!p));
    }
    ids.forEach((id) => this.measuring.set(id, (this.measuring.get(id) ?? 0) + 1));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) {
        const n = (this.measuring.get(id) ?? 1) - 1;
        if (n > 0) this.measuring.set(id, n);
        else this.measuring.delete(id);
      }
    };
  }

  isMeasuring(id: string): boolean {
    return this.measuring.has(id);
  }

  /** Midiendo en este proceso o usado por un job programado con status 'running'. */
  async isBusy(id: string): Promise<boolean> {
    return this.isMeasuring(id) || (await runningJobDeviceIds(this.prisma)).has(id);
  }

  /** Ejecuta un cambio de configuración en exclusiva sobre el dispositivo. */
  async runConfiguration<T>(device: { id: string; name: string }, fn: () => Promise<T>): Promise<T> {
    if (this.configuring.has(device.id)) {
      throw new ConflictException(`Ya hay un cambio de configuración en curso para "${device.name}"`);
    }
    // Se marca antes de cualquier await para que una medición que empiece ahora espere.
    let done!: () => void;
    this.configuring.set(device.id, new Promise<void>((r) => (done = r)));
    try {
      if (await this.isBusy(device.id)) {
        throw new ConflictException(`"${device.name}" está midiendo; espera a que termine para cambiar su configuración`);
      }
      return await fn();
    } finally {
      this.configuring.delete(device.id);
      done();
    }
  }
}
