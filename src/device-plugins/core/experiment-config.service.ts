import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Device, TaskPreference, TaskPreferenceRange } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DevicePluginRegistry } from './device-plugin.registry';
import type { ActuatorPlugin, DeviceContext, DeviceServiceDescription, SensorPlugin } from './device-plugin.interface';
import { toDeviceContext } from './configuration';
import { AcquisitionMetadata, acquisitionOf } from './acquisition';
import {
  ChannelRange,
  MeasurementValueMeta,
  channelRangeFor,
  experimentConfigError,
  invalidChannels,
  channelRangeMessage,
  typeLabel,
  valueMetasOf,
} from './experiment-config';
import { ExperimentDefinition, experimentFor } from './experiments';

export interface ResolvedExperiment {
  preference: TaskPreference & { analyzerDevice: Device; muxDevice: Device | null; ranges: TaskPreferenceRange[] };
  sensor: { plugin: SensorPlugin; description: DeviceServiceDescription; context: DeviceContext };
  selector: {
    plugin: ActuatorPlugin;
    description: DeviceServiceDescription;
    context: DeviceContext;
    actuatorId: string;
    valueName: string;
  } | null;
  channelRange: ChannelRange;
  valueMetas: MeasurementValueMeta[];
  experiment: ExperimentDefinition;
  acquisition: AcquisitionMetadata;
}

const mismatch = (d: { name: string; type: string | null }, what: string) =>
  `La configuración de la tarea usa "${d.name}" (${typeLabel(d.type)}), que no es ${what} registrado; revisa la configuración`;

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
      taskProjectId: task.projectId,
      sensor,
      selector: mux,
      sensorRole,
      selectorRole: mux ? this.registry.role(mux.type) : undefined,
      sensorDescription: sensorRole === 'sensor' ? this.registry.describe(sensor.type!) : undefined,
    });
    if (error) throw new BadRequestException(error);
  }

  /** Experimento activo de la tarea: plugin y contexto del sensor y, si hay, del selector de canal. */
  async resolve(taskId: number): Promise<ResolvedExperiment | null> {
    const preference = await this.prisma.taskPreference.findFirst({
      where: { taskId }, orderBy: { createdAt: 'desc' },
      include: { analyzerDevice: true, muxDevice: true, ranges: { orderBy: { order: 'asc' } } },
    });
    if (!preference) return null;
    const s = preference.analyzerDevice;
    const m = preference.muxDevice;
    if (this.registry.role(s.type) !== 'sensor') throw new BadRequestException(mismatch(s, 'un equipo de medición'));
    if (m && this.registry.role(m.type) !== 'channel-selector') throw new BadRequestException(mismatch(m, 'un selector de canal'));

    const sensorDescription = this.registry.describe(s.type!);
    const sensor = {
      plugin: this.registry.sensor(s.type),
      description: sensorDescription,
      context: toDeviceContext(s, sensorDescription),
    };
    let selector: ResolvedExperiment['selector'] = null;
    if (m) {
      const cs = this.registry.channelSelector(m.type);
      const description = this.registry.describe(m.type!);
      selector = {
        plugin: cs.plugin,
        description,
        context: toDeviceContext(m, description),
        actuatorId: cs.actuatorId,
        valueName: cs.valueName,
      };
    }
    return {
      preference,
      sensor,
      selector,
      channelRange: channelRangeFor(selector?.description ?? null),
      valueMetas: valueMetasOf(sensorDescription),
      experiment: experimentFor(this.registry.catalog(), s.type, m?.type ?? null)!,
      acquisition: acquisitionOf(sensorDescription)!,
    };
  }

  async assertChannels(taskId: number, channels: number[]): Promise<ResolvedExperiment> {
    const resolved = await this.resolve(taskId);
    if (!resolved) throw new BadRequestException('Esta tarea no tiene un equipo de medición asignado. Configúralo antes de medir.');
    const bad = invalidChannels(channels, resolved.channelRange);
    if (bad.length) throw new BadRequestException(channelRangeMessage(resolved.channelRange, bad));
    return resolved;
  }

  /** Para mostrar (GET /tasks/:id): nunca lanza; tipos sin plugin o con rol incorrecto caen a valores por defecto. */
  summarize(pref: { analyzerDevice: { type: string | null }; muxDevice: { type: string | null } | null }) {
    const m = pref.muxDevice;
    const selectorDescription = m && this.registry.role(m.type) === 'channel-selector' ? this.registry.describe(m.type!) : null;
    const channelRange = channelRangeFor(selectorDescription);
    const found = experimentFor(this.registry.catalog(), pref.analyzerDevice.type, m?.type ?? null);
    const experiment = found ? { experimentId: found.experimentId, fullName: found.fullName } : null;
    if (this.registry.role(pref.analyzerDevice.type) !== 'sensor') {
      return { channelRange, sensorValues: [], simulated: false, experiment, acquisition: null };
    }
    const d = this.registry.describe(pref.analyzerDevice.type!);
    return { channelRange, sensorValues: valueMetasOf(d), simulated: d.simulated, experiment, acquisition: acquisitionOf(d) };
  }
}
