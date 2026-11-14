import { Injectable, Logger, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { UpdateDeviceStatusDto } from './dto/update-device-status.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { DEVICE_OPS_QUEUE, TestConnectionJobData } from '@app/queue';

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
      private prisma: PrismaService,
      private teamScope: TeamScopeService,
      @InjectQueue(DEVICE_OPS_QUEUE) private deviceOpsQueue: Queue<TestConnectionJobData>,
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

  async createInProject(projectId: string, createDeviceDto: CreateDeviceDto, userId: string) {
    await this.teamScope.assertProjectInTeam(userId, projectId);
    return this.prisma.device.create({
      data: {
        ...createDeviceDto,
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

  async testConnection(dto: TestConnectionDto): Promise<{ success: boolean; message: string }> {
    const { type, ip } = dto;
    const port = dto.port ?? 3570;

    const reachable = await this.runTestConnectionJob(type, ip, port);
    if (reachable) {
      return {
        success: true,
        message: type === 'analyzer' ? `Hioki IM3570 encontrado en ${ip}:${port}` : `MUX encontrado en ${ip}`,
      };
    }
    return {
      success: false,
      message: type === 'analyzer'
        ? `No se pudo conectar al analyzer en ${ip}:${port}`
        : `No se pudo conectar al MUX en ${ip}`,
    };
  }

  /**
   * La API no abre sockets hacia el laboratorio: delega el chequeo en el worker
   * vía la cola 'device-ops'. Cualquier fallo (Redis caído, timeout) cuenta como
   * "no alcanzable".
   */
  private async runTestConnectionJob(type: string, ip: string, port: number): Promise<boolean> {
    const timeoutMs = Number(process.env.DEVICE_TEST_TIMEOUT_MS) || 5000;
    let job: Awaited<ReturnType<Queue<TestConnectionJobData>['add']>> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      job = await this.deviceOpsQueue.add(
        'test-connection',
        { type, ip, port },
        { attempts: 1, removeOnComplete: true, removeOnFail: true },
      );
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout tras ${timeoutMs}ms`)), timeoutMs);
      });
      return Boolean(await Promise.race([job.finished(), timeout]));
    } catch (err) {
      this.logger.warn(`test-connection ${type} ${ip}:${port} falló: ${(err as Error).message}`);
      if (job) {
        try {
          await job.remove();
        } catch {
          // best-effort
        }
      }
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
