import { Injectable, BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Device, Prisma } from '@prisma/client';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { UpdateDeviceStatusDto } from './dto/update-device-status.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { DeviceTypeCatalogEntry, LaasCatalog } from '@app/laas-catalog';
import { DeviceOpsClient } from '@app/queue';
import { DeviceConfigurationService } from './device-configuration.service';
import { deviceTestTimeoutMs } from './device-op-errors';

@Injectable()
export class DevicesService {
  constructor(
      private prisma: PrismaService,
      private teamScope: TeamScopeService,
      private catalog: LaasCatalog,
      private deviceConfiguration: DeviceConfigurationService,
      private deviceOps: DeviceOpsClient,
  ) {}

  // ── Global: todos los dispositivos de proyectos del equipo del usuario ──────

  async findAllForUser(userId: string) {
    // Setear contexto RLS de forma parametrizada (sin interpolación directa)
    await this.prisma
        .$executeRaw`SELECT set_config('app.current_user_id', ${userId}, false)`;

    const teamWhere = await this.teamScope.projectWhereForUser(userId);

    return this.prisma.device.findMany({
      where: { project: teamWhere },
      include: {
        project: {
          select: { uuid: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Scoped por proyecto (siempre verificando equipo del caller) ────────────

  async findByProject(projectId: string, userId: string) {
    await this.teamScope.assertProjectInTeam(userId, projectId);
    return this.prisma.device.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneInProject(projectId: string, deviceId: string, userId: string) {
    await this.teamScope.assertProjectInTeam(userId, projectId);
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device || device.projectId !== projectId) {
      throw new NotFoundException('Device not found in this project');
    }

    return device;
  }

  /** Tipo de dispositivo según el catálogo de plugins registrados (IEEE 1876 §4). */
  catalogEntry(type: string | null | undefined): DeviceTypeCatalogEntry {
    const entry = this.catalog.catalog().find((e) => e.deviceType === type);
    if (!entry) throw new BadRequestException(`Tipo de dispositivo desconocido: "${type}"`);
    return entry;
  }

  async createInProject(projectId: string, createDeviceDto: CreateDeviceDto, userId: string) {
    await this.teamScope.assertProjectInTeam(userId, projectId);
    const entry = this.catalogEntry(createDeviceDto.type);
    return this.prisma.device.create({
      data: {
        ...createDeviceDto,
        ip: entry.connection.requiresIp ? createDeviceDto.ip : null,
        projectId,
      },
    });
  }

  async updateInProject(
      projectId: string,
      deviceId: string,
      updateDeviceDto: UpdateDeviceDto,
      userId: string,
  ) {
    const device = await this.findOneInProject(projectId, deviceId, userId);
    const data: Prisma.DeviceUncheckedUpdateInput = { ...updateDeviceDto };
    if (updateDeviceDto.type !== undefined) {
      const entry = this.catalogEntry(updateDeviceDto.type);
      if (updateDeviceDto.type !== device.type) {
        // Cambiar el tipo invalidaría las configuraciones de tareas que ya lo usan como equipo/MUX.
        const usageCount = await this.prisma.taskPreference.count({
          where: { OR: [{ sensorDeviceId: deviceId }, { channelSelectorDeviceId: deviceId }] },
        });
        if (usageCount > 0) {
          throw new BadRequestException(
              'No se puede cambiar el tipo: el dispositivo está en uso en configuraciones de tareas. Quítalo de esas configuraciones primero.',
          );
        }
        // La configuración guardada pertenece al modelo anterior.
        data.configuration = Prisma.DbNull;
      }
      // Misma regla que al crear: los tipos sin dirección no guardan IP.
      if (!entry.connection.requiresIp) data.ip = null;
    }

    return this.prisma.device.update({
      where: { id: deviceId },
      data,
    });
  }

  /** Archivar/desarchivar: los demás estados (online/offline) los controla el health check automático. */
  async updateStatusInProject(
      projectId: string,
      deviceId: string,
      dto: UpdateDeviceStatusDto,
      userId: string,
  ) {
    await this.findOneInProject(projectId, deviceId, userId);

    return this.prisma.device.update({
      where: { id: deviceId },
      data: { status: dto.status },
    });
  }

  async removeFromProject(projectId: string, deviceId: string, userId: string) {
    await this.findOneInProject(projectId, deviceId, userId);

    const usageCount = await this.prisma.taskPreference.count({
      where: {
        OR: [
          { sensorDeviceId: deviceId },
          { channelSelectorDeviceId: deviceId },
        ],
      },
    });

    if (usageCount > 0) {
      throw new HttpException(
          'No se puede eliminar: el dispositivo está en uso en configuraciones de tareas',
          HttpStatus.CONFLICT,
      );
    }

    return this.prisma.device.delete({
      where: { id: deviceId },
    });
  }

  // ── Test de conexión ───────────────────────────────────────────────────────

  async testConnection(dto: TestConnectionDto) {
    const entry = this.catalogEntry(dto.type);
    if (entry.connection.requiresIp && !dto.ip) throw new BadRequestException('Este tipo de dispositivo requiere una IP');
    const port = dto.port ?? entry.connection.defaultPort;
    const where = dto.ip ? `${dto.ip}${port && entry.connection.defaultPort ? `:${port}` : ''}` : '';
    const reachable = await this.workerReachable(dto.type, dto.ip ?? '', port ?? 0);
    if (!entry.connection.requiresIp) {
      return { success: reachable, message: `${entry.label} ${reachable ? 'disponible' : 'no disponible'}${entry.simulated ? ' (simulado)' : ''}` };
    }
    return reachable
      ? { success: true, message: `${entry.label} encontrado en ${where}` }
      : { success: false, message: `No se pudo conectar a ${entry.label} en ${where}` };
  }

  /**
   * La API no abre sockets hacia el laboratorio: delega el chequeo en el worker (cola 'device-ops').
   * Cualquier fallo (worker sin respuesta, error) cuenta como "no alcanzable".
   */
  private async workerReachable(type: string, ip: string, port: number): Promise<boolean> {
    try {
      return (await this.deviceOps.request<boolean>('test-connection', { type, ip, port }, deviceTestTimeoutMs())) === true;
    } catch {
      return false;
    }
  }

  /** Dispositivo de un proyecto del equipo del usuario, o 404. */
  private async findForUser(deviceId: string, userId: string): Promise<Device> {
    const teamWhere = await this.teamScope.projectWhereForUser(userId);
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, project: teamWhere } });
    if (!device) throw new NotFoundException('Device not found');
    return device;
  }

  /** getConfiguration: parámetros declarados por el plugin con su valor actual. */
  async configurationForUser(deviceId: string, userId: string) {
    return this.deviceConfiguration.view(await this.findForUser(deviceId, userId));
  }

  /** setConfiguration: valida, aplica en vivo y/o guarda; rechazado mientras el dispositivo mide. */
  async configureForUser(deviceId: string, values: Record<string, unknown>, userId: string) {
    return this.deviceConfiguration.apply(await this.findForUser(deviceId, userId), values);
  }

  /** Service description (IEEE 1876 §4.2) + metadata de instancia para un dispositivo del equipo del usuario. */
  async describeForUser(deviceId: string, userId: string) {
    const { id, name, type, ip, status, projectId } = await this.findForUser(deviceId, userId);
    const device = { id, name, type, ip, status, projectId };
    const role = this.catalog.role(device.type);
    if (!role) throw new NotFoundException(`No hay un device plugin registrado para el tipo "${device.type}"`);
    let service = this.catalog.describe(device.type!);
    if (role === 'sensor') {
      // Aproximación: mediciones de tareas cuya preferencia ACTUAL usa este dispositivo.
      const last = await this.prisma.measurement.findFirst({
        where: { task: { taskPreferences: { some: { sensorDeviceId: device.id } } } },
        orderBy: { takenAt: { sort: 'desc', nulls: 'last' } },
        select: { takenAt: true },
      });
      const lastMeasured = last?.takenAt?.toISOString();
      if (lastMeasured) {
        service = { ...service, sensors: service.sensors.map((s) => ({
          ...s, sensorValues: s.sensorValues.map((v) => ({ ...v, lastMeasured })),
        })) };
      }
    }
    return { device, role, service };
  }
}
