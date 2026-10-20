import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Device, TaskPreference, TaskPreferenceRange } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DevicePluginRegistry } from './device-plugin.registry';
import { DeviceDriverPlugin, DeviceServiceDescription } from './device-plugin.interface';
import {
  CHANNEL_SLOTS,
  ChannelRange,
  MeasurementValueMeta,
  channelRangeFor,
  experimentConfigError,
  invalidChannels,
  channelRangeMessage,
  valueMetasOf,
} from './experiment-config';

export interface ResolvedExperiment {
  preference: TaskPreference & { analyzerDevice: Device; muxDevice: Device | null; ranges: TaskPreferenceRange[] };
  plugin: DeviceDriverPlugin;
  description: DeviceServiceDescription;
  channelRange: ChannelRange;
  valueMetas: MeasurementValueMeta[];
}

@Injectable()
export class ExperimentConfigService {
  constructor(private prisma: PrismaService, private registry: DevicePluginRegistry) {}

  async assertValidConfig(taskId: number, analyzerDeviceId: string, muxDeviceId: string | null): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (!task) throw new NotFoundException('Task not found');
    const sensor = await this.prisma.device.findUnique({ where: { id: analyzerDeviceId } });
    if (!sensor) throw new NotFoundException('Equipo de medición no encontrado');
    const mux = muxDeviceId ? await this.prisma.device.findUnique({ where: { id: muxDeviceId } }) : null;
    if (muxDeviceId && !mux) throw new NotFoundException('MUX no encontrado');
    const sensorRole = this.registry.role(sensor.type);
    const error = experimentConfigError({
      taskProjectId: task.projectId, sensor, mux, sensorRole,
      description: sensorRole === 'sensor' ? this.registry.describe(sensor.type!) : undefined,
    });
    if (error) throw new BadRequestException(error);
  }

  async resolve(taskId: number): Promise<ResolvedExperiment | null> {
    const preference = await this.prisma.taskPreference.findFirst({
      where: { taskId }, orderBy: { createdAt: 'desc' },
      include: { analyzerDevice: true, muxDevice: true, ranges: { orderBy: { order: 'asc' } } },
    });
    if (!preference) return null;
    const plugin = this.registry.get(preference.analyzerDevice.type); // 404 si el tipo no tiene plugin
    const description = plugin.describe();
    return {
      preference, plugin, description,
      channelRange: channelRangeFor(description, !!preference.muxDevice),
      valueMetas: valueMetasOf(description),
    };
  }

  async assertChannels(taskId: number, channels: number[]): Promise<ResolvedExperiment> {
    const resolved = await this.resolve(taskId);
    if (!resolved) throw new BadRequestException('Esta tarea no tiene un equipo de medición asignado. Configúralo antes de medir.');
    const bad = invalidChannels(channels, resolved.channelRange);
    if (bad.length) throw new BadRequestException(channelRangeMessage(resolved.channelRange, bad));
    return resolved;
  }

  /** Para mostrar (GET /tasks/:id): nunca lanza; tipos sin plugin caen a valores por defecto. */
  summarize(pref: { analyzerDevice: { type: string | null }; muxDevice: unknown | null }) {
    if (this.registry.role(pref.analyzerDevice.type) !== 'sensor') {
      return { channelRange: { min: 1, max: pref.muxDevice ? CHANNEL_SLOTS : 1 }, sensorValues: [], simulated: false };
    }
    const d = this.registry.describe(pref.analyzerDevice.type!);
    return { channelRange: channelRangeFor(d, !!pref.muxDevice), sensorValues: valueMetasOf(d), simulated: d.simulated };
  }
}
