import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Device } from '@prisma/client';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { ExperimentConfigService, toSweepRanges } from '@app/experiments';
import {
  ActuatorMetadata,
  LaasCatalog,
  SensorMetadata,
  channelNumbersOf,
  parseAcquisitionSnapshot,
  parseSensorValues,
  storedPointsOf,
} from '@app/laas-catalog';
import { DeviceOpsClient } from '@app/queue';
import { DeviceStateService, deviceBusyMessage } from '@app/redis';
import { MeasurementSchedulingService } from '../scheduler/scheduling.service';
import { deviceOpTimeoutMs, mapDeviceOpError } from '../devices/device-op-errors';
import { parseLaasId, toLaasId } from './laas-ids';
import {
  LaasActuator,
  LaasSensor,
  LaasSensorData,
  deviceRefOf,
  publishActuator,
  publishSensor,
  sensorDataOf,
} from './laas-publish';

export interface FreshSensorDataJob { jobId: string; taskId: number; estimatedSeconds: number }
export interface ActuatorDataResult { actuatorId: string; values: Record<string, number>; appliedAt: string }

const NO_PREFERENCE = 'Esta tarea no tiene un equipo de medición asignado. Configúralo antes de medir.';

/** Cuerpo de setActuatorData: `values` objeto no vacío de números finitos. */
export function actuatorBodyError(values: unknown): string | null {
  const ok = !!values && typeof values === 'object' && !Array.isArray(values) &&
    Object.keys(values).length > 0 &&
    Object.values(values).every((v) => typeof v === 'number' && Number.isFinite(v));
  return ok ? null : 'values debe ser un objeto no vacío { <nombre>: número }';
}

/**
 * Instancias LaaS (diseño §7.3): sensores y actuadores de los equipos no archivados de los
 * proyectos del equipo de trabajo del usuario. Lecturas desde la base (atribución por
 * `measurements.sensorDeviceId/sensorId`); la E/S con el laboratorio la hace el worker.
 */
@Injectable()
export class LaasInstancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teamScope: TeamScopeService,
    private readonly catalog: LaasCatalog,
    private readonly experimentConfig: ExperimentConfigService,
    private readonly scheduling: MeasurementSchedulingService,
    private readonly deviceOps: DeviceOpsClient,
    private readonly deviceState: DeviceStateService,
  ) {}

  // ── Dispositivos del equipo ───────────────────────────────────────────────

  /** Dispositivos del equipo con modelo en el catálogo; con `deviceId`, ese (o 404). */
  private async devices(userId: string, deviceId?: string): Promise<Device[]> {
    const project = await this.teamScope.projectWhereForUser(userId);
    const devices = await this.prisma.device.findMany({
      where: { project, status: { not: 'archived' }, ...(deviceId ? { id: deviceId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    if (deviceId && devices.length === 0) throw new NotFoundException('Device not found');
    return devices.filter((d) => this.catalog.has(d.type));
  }

  private async findDevice(userId: string, deviceId: string): Promise<Device | null> {
    const project = await this.teamScope.projectWhereForUser(userId);
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, project, status: { not: 'archived' } } });
    return device && this.catalog.has(device.type) ? device : null;
  }

  private async resolveSensor(userId: string, laasId: string): Promise<{ device: Device; sensor: SensorMetadata; sensorId: string }> {
    const { deviceId, catalogId } = parseLaasId(laasId);
    const device = await this.findDevice(userId, deviceId);
    const sensor = device ? this.catalog.describe(device.type).sensors.find((s) => s.sensorId === catalogId) : undefined;
    if (!device || !sensor) throw new NotFoundException('Sensor no encontrado');
    return { device, sensor, sensorId: toLaasId(deviceId, catalogId) };
  }

  private async resolveActuator(userId: string, laasId: string): Promise<{ device: Device; actuator: ActuatorMetadata; actuatorId: string }> {
    const { deviceId, catalogId } = parseLaasId(laasId);
    const device = await this.findDevice(userId, deviceId);
    const actuator = device ? this.catalog.describe(device.type).actuators.find((a) => a.actuatorId === catalogId) : undefined;
    if (!device || !actuator) throw new NotFoundException('Actuador no encontrado');
    return { device, actuator, actuatorId: toLaasId(deviceId, catalogId) };
  }

  // ── getSensorMetadata / getActuatorMetadata ───────────────────────────────

  async sensors(userId: string, deviceId?: string): Promise<LaasSensor[]> {
    const devices = (await this.devices(userId, deviceId)).filter((d) => this.catalog.describe(d.type).sensors.length > 0);
    const last = await this.lastMeasured(devices.map((d) => d.id));
    return devices.flatMap((d) =>
      this.catalog.describe(d.type).sensors.map((s) => publishSensor(deviceRefOf(d), s, last.get(toLaasId(d.id, s.sensorId)))),
    );
  }

  /** Última medición por (equipo, sensor del catálogo), en una sola consulta. */
  private async lastMeasured(deviceIds: string[]): Promise<Map<string, string>> {
    if (deviceIds.length === 0) return new Map();
    const rows = await this.prisma.measurement.groupBy({
      by: ['sensorDeviceId', 'sensorId'],
      where: { sensorDeviceId: { in: deviceIds } },
      _max: { takenAt: true },
    });
    const out = new Map<string, string>();
    for (const r of rows) {
      const at = r._max.takenAt;
      if (r.sensorDeviceId && r.sensorId && at) out.set(toLaasId(r.sensorDeviceId, r.sensorId), at.toISOString());
    }
    return out;
  }

  async actuators(userId: string, deviceId?: string): Promise<LaasActuator[]> {
    const devices = await this.devices(userId, deviceId);
    return devices.flatMap((d) => this.catalog.describe(d.type).actuators.map((a) => publishActuator(deviceRefOf(d), a)));
  }

  // ── getSensorData ─────────────────────────────────────────────────────────

  /** Última medición tomada con ese equipo y sensor (de cualquier tarea del equipo de trabajo, o de `taskId`). */
  async sensorData(userId: string, laasId: string, taskId?: number): Promise<LaasSensorData> {
    const { device, sensor, sensorId } = await this.resolveSensor(userId, laasId);
    if (taskId !== undefined) await this.teamScope.assertTaskInTeam(userId, taskId);
    const project = await this.teamScope.projectWhereForUser(userId);
    const m = await this.prisma.measurement.findFirst({
      where: {
        sensorDeviceId: device.id,
        sensorId: sensor.sensorId,
        task: { project },
        ...(taskId !== undefined ? { taskId } : {}),
      },
      orderBy: [{ takenAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      select: {
        id: true, taskId: true, takenAt: true, acquisition: true, sensorValues: true, data: true,
        measurementChannels: { select: { channelNumber: true } },
      },
    });
    if (!m) throw new NotFoundException('No hay lecturas de este sensor');
    return sensorDataOf(sensorId, {
      id: m.id,
      taskId: m.taskId,
      takenAt: m.takenAt,
      acquisition: parseAcquisitionSnapshot(m.acquisition),
      sensorValues: parseSensorValues(m.sensorValues),
      points: storedPointsOf(m.data),
      channels: channelNumbersOf(m.measurementChannels),
    });
  }

  /**
   * getSensorData con fresh=true: encola una medición de la tarea por la admisión existente
   * (rangos de su configuración; canales pedidos o todos los del experimento). La tarea debe usar
   * ese equipo como sensor.
   */
  async requestFresh(userId: string, laasId: string, taskId: number | undefined, channels: number[] | undefined): Promise<FreshSensorDataJob> {
    const { device } = await this.resolveSensor(userId, laasId);
    if (taskId === undefined) throw new BadRequestException('Indica taskId para pedir una lectura nueva (fresh=true)');
    await this.teamScope.assertTaskInTeam(userId, taskId);
    const resolved = await this.experimentConfig.resolve(taskId);
    if (!resolved) throw new BadRequestException(NO_PREFERENCE);
    if (resolved.preference.sensorDeviceId !== device.id) {
      throw new BadRequestException(
        `La tarea no mide con este sensor: su equipo de medición es "${resolved.preference.sensorDevice.name}"`,
      );
    }
    const { min, max } = resolved.channelRange;
    const selectedChannels = channels ?? Array.from({ length: max - min + 1 }, (_, i) => min + i);
    const job = await this.scheduling.requestMeasurement(taskId, userId, {
      ranges: toSweepRanges(resolved.preference.ranges),
      selectedChannels,
      jobId: `${taskId}-${Date.now()}`,
    });
    return { jobId: job.jobId, taskId, estimatedSeconds: job.estimatedSeconds };
  }

  // ── setActuatorData ───────────────────────────────────────────────────────

  /** Rangos validados por el worker (400), lock del dispositivo (409), timeout (504). */
  async setActuatorData(userId: string, laasId: string, values: unknown): Promise<ActuatorDataResult> {
    const { device, actuator, actuatorId } = await this.resolveActuator(userId, laasId);
    const bodyError = actuatorBodyError(values);
    if (bodyError) throw new BadRequestException(bodyError);
    const checked = values as Record<string, number>;
    if (this.catalog.describe(device.type).connection.requiresIp && !device.ip) {
      throw new BadRequestException(`"${device.name}" no tiene IP configurada`);
    }
    // Camino rápido: el 409 definitivo lo da el worker al tomar el lock.
    if (await this.deviceState.isBusy(device.id)) throw new ConflictException(deviceBusyMessage(device.name));
    try {
      await this.deviceOps.request(
        'set-actuator-data',
        { deviceId: device.id, actuatorId: actuator.actuatorId, values: checked },
        deviceOpTimeoutMs(),
      );
    } catch (e) {
      throw mapDeviceOpError(e, device.name, 'el valor del actuador');
    }
    return { actuatorId, values: checked, appliedAt: new Date().toISOString() };
  }
}
