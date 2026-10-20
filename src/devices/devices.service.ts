import { Injectable, BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TeamScopeService } from '../common/team-scope.service';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { UpdateDeviceStatusDto } from './dto/update-device-status.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { DevicePluginRegistry, DeviceTypeCatalogEntry } from '../device-plugins/device-plugin.registry';

@Injectable()
export class DevicesService {
  constructor(
      private prisma: PrismaService,
      private teamScope: TeamScopeService,
      private devicePlugins: DevicePluginRegistry,
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
    const entry = this.devicePlugins.catalog().find((e) => e.deviceType === type);
    if (!entry) throw new BadRequestException(`Tipo de dispositivo desconocido: "${type}"`);
    return entry;
  }

  /** Tipos de dispositivo que no requieren IP (ej. simulados), usado por el health check. */
  addresslessTypes(): string[] {
    return this.devicePlugins.catalog().filter((e) => !e.connection.requiresIp).map((e) => e.deviceType);
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
    await this.findOneInProject(projectId, deviceId, userId);
    if (updateDeviceDto.type !== undefined) this.catalogEntry(updateDeviceDto.type);

    return this.prisma.device.update({
      where: { id: deviceId },
      data: updateDeviceDto,
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
          { analyzerDeviceId: deviceId },
          { muxDeviceId: deviceId },
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
    const reachable = await this.checkReachable(dto.type, dto.ip ?? null, port);
    if (!entry.connection.requiresIp) {
      return { success: reachable, message: `${entry.label} ${reachable ? 'disponible' : 'no disponible'}${entry.simulated ? ' (simulado)' : ''}` };
    }
    return reachable
      ? { success: true, message: `${entry.label} encontrado en ${where}` }
      : { success: false, message: `No se pudo conectar a ${entry.label} en ${where}` };
  }

  /**
   * Chequeo crudo de alcanzabilidad (sin mensajes), usado también por el health check
   * periódico. Delega en el plugin registrado para `type` — un dispositivo nuevo
   * (type distinto) queda cubierto automáticamente con solo registrar su plugin.
   */
  async checkReachable(type: string, ip: string | null, port?: number): Promise<boolean> {
    if (!this.devicePlugins.has(type)) return false;
    const entry = this.devicePlugins.catalog().find((e) => e.deviceType === type)!;
    if (entry.connection.requiresIp && !ip) return false;
    return this.devicePlugins.get(type).testConnection(ip ?? '', type, port ?? entry.connection.defaultPort);
  }

  /** Service description (IEEE 1876 §4.2) + metadata de instancia para un dispositivo del equipo del usuario. */
  async describeForUser(deviceId: string, userId: string) {
    const teamWhere = await this.teamScope.projectWhereForUser(userId);
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, project: teamWhere },
      select: { id: true, name: true, type: true, ip: true, status: true, projectId: true },
    });
    if (!device) throw new NotFoundException('Device not found');
    const role = this.devicePlugins.role(device.type);
    if (!role) throw new NotFoundException(`No hay un device plugin registrado para el tipo "${device.type}"`);
    let service = this.devicePlugins.describe(device.type!);
    if (role === 'sensor') {
      // Aproximación: mediciones de tareas cuya preferencia ACTUAL usa este dispositivo.
      const last = await this.prisma.measurement.findFirst({
        where: { task: { taskPreferences: { some: { analyzerDeviceId: device.id } } } },
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
