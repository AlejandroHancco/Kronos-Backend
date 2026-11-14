import { Processor, Process } from '@nestjs/bull';
import type { Job } from 'bull';
import { DevicePluginRegistry } from '@app/device-plugins';
import { DEVICE_OPS_QUEUE, TestConnectionJobData } from '@app/queue';

/**
 * Procesador de la cola 'device-ops': operaciones de red cortas sobre dispositivos
 * (test de conexión). Solo el worker abre sockets hacia el hardware.
 */
@Processor(DEVICE_OPS_QUEUE)
export class DeviceOpsProcessor {
  constructor(private readonly devicePlugins: DevicePluginRegistry) {}

  @Process({ name: 'test-connection', concurrency: 5 })
  async handle(job: Job<TestConnectionJobData>): Promise<boolean> {
    const { type, ip, port } = job.data;
    if (!this.devicePlugins.has(type)) return false;
    return this.devicePlugins.get(type).testConnection(ip, type, port);
  }
}
