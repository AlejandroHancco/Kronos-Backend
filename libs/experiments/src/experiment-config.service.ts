import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Device, Prisma, TaskPreference, TaskPreferenceRange } from '@prisma/client';
import { PrismaService } from '@app/database';
import {
  AcquisitionMetadata,
  ChannelRange,
  DeviceContext,
  DeviceServiceDescription,
  ExperimentDefinition,
  LaasCatalog,
  MeasurementValueMeta,
  SweepRange,
  acquisitionOf,
  channelRangeFor,
  channelRangeMessage,
  experimentConfigError,
  experimentFor,
  invalidChannels,
  rangesError,
  toDeviceContext,
  typeLabel,
  valueMetasOf,
} from '@app/laas-catalog';

/**
 * Experimento activo de una tarea, resuelto solo con metadata del catálogo (sin drivers): quien
 * ejecuta la medición resuelve los drivers por el tipo de cada dispositivo.
 */
export interface ResolvedExperiment {
  preference: TaskPreference & { sensorDevice: Device; channelSelectorDevice: Device | null; ranges: TaskPreferenceRange[] };
  sensor: { description: DeviceServiceDescription; context: DeviceContext };
  selector: {
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

/** Rangos guardados (Decimal de Prisma) → SweepRange numérico, para validar contra la adquisición del sensor. */
export const toSweepRanges = (rows: { start: Prisma.Decimal | number; stop: Prisma.Decimal | number; points: number; scale: string }[]): SweepRange[] =>
  rows.map((r) => ({ start: Number(r.start), stop: Number(r.stop), points: r.points, scale: r.scale }));

@Injectable()
export class ExperimentConfigService {
  constructor(private prisma: PrismaService, private catalog: LaasCatalog) {}

  /** Valida la configuración y devuelve la adquisición del sensor (para estimar duraciones con ella). */
  async assertValidConfig(taskId: number, sensorDeviceId: string, channelSelectorDeviceId: string | null, ranges: SweepRange[]): Promise<AcquisitionMetadata> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (!task) throw new NotFoundException('Task not found');
    const sensor = await this.prisma.device.findUnique({ where: { id: sensorDeviceId } });
    if (!sensor) throw new NotFoundException('Equipo de medición no encontrado');
    const selector = channelSelectorDeviceId ? await this.prisma.device.findUnique({ where: { id: channelSelectorDeviceId } }) : null;
    if (channelSelectorDeviceId && !selector) throw new NotFoundException('Selector de canal no encontrado');
    const sensorRole = this.catalog.role(sensor.type);
    const error = experimentConfigError({
      taskProjectId: task.projectId,
      sensor,
      selector,
      sensorRole,
      selectorRole: selector ? this.catalog.role(selector.type) : undefined,
      sensorDescription: sensorRole === 'sensor' ? this.catalog.describe(sensor.type!) : undefined,
    });
    if (error) throw new BadRequestException(error);
    const d = this.catalog.describe(sensor.type!);
    const acquisition = acquisitionOf(d)!;
    const rangeError = rangesError(acquisition, ranges, d.shortName);
    if (rangeError) throw new BadRequestException(rangeError);
    return acquisition;
  }

  /** Rangos de barrido contra la adquisición ya resuelta del sensor (usado por measureTask). */
  assertRanges(resolved: ResolvedExperiment, ranges: SweepRange[]): void {
    const error = rangesError(resolved.acquisition, ranges, resolved.sensor.description.shortName);
    if (error) throw new BadRequestException(error);
  }

  /** Experimento activo de la tarea: descripción y contexto del sensor y, si hay, del selector de canal. */
  async resolve(taskId: number): Promise<ResolvedExperiment | null> {
    const preference = await this.prisma.taskPreference.findFirst({
      where: { taskId }, orderBy: { createdAt: 'desc' },
      include: { sensorDevice: true, channelSelectorDevice: true, ranges: { orderBy: { order: 'asc' } } },
    });
    if (!preference) return null;
    const s = preference.sensorDevice;
    const m = preference.channelSelectorDevice;
    if (this.catalog.role(s.type) !== 'sensor') throw new BadRequestException(mismatch(s, 'un equipo de medición'));
    if (m && this.catalog.role(m.type) !== 'channel-selector') throw new BadRequestException(mismatch(m, 'un selector de canal'));

    const sensorDescription = this.catalog.describe(s.type!);
    const sensor = {
      description: sensorDescription,
      context: toDeviceContext(s, sensorDescription),
    };
    let selector: ResolvedExperiment['selector'] = null;
    if (m) {
      const cs = this.catalog.channelSelector(m.type);
      const description = this.catalog.describe(m.type!);
      selector = {
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
      experiment: experimentFor(this.catalog.catalog(), s.type, m?.type ?? null)!,
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

  /** Para mostrar (GET /tasks/:id): nunca lanza; tipos sin modelo en el catálogo o con rol incorrecto caen a valores por defecto. */
  summarize(pref: { sensorDevice: { type: string | null }; channelSelectorDevice: { type: string | null } | null }) {
    const m = pref.channelSelectorDevice;
    const selectorDescription = m && this.catalog.role(m.type) === 'channel-selector' ? this.catalog.describe(m.type!) : null;
    const channelRange = channelRangeFor(selectorDescription);
    const found = experimentFor(this.catalog.catalog(), pref.sensorDevice.type, m?.type ?? null);
    const experiment = found ? { experimentId: found.experimentId, fullName: found.fullName } : null;
    if (this.catalog.role(pref.sensorDevice.type) !== 'sensor') {
      return { channelRange, sensorValues: [], simulated: false, experiment, acquisition: null };
    }
    const d = this.catalog.describe(pref.sensorDevice.type!);
    return { channelRange, sensorValues: valueMetasOf(d), simulated: d.simulated, experiment, acquisition: acquisitionOf(d) };
  }
}
