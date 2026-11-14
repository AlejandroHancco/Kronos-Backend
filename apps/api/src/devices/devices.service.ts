import { Injectable, Logger, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { CreateDeviceDto } from './dto/create-device.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { UpdateDeviceStatusDto } from './dto/update-device-status.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
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
   *
   * No usa Job.finished(): deja listeners globales y un sondeo cada 5 s vivos
   * hasta que el job termina (nunca, si se elimina tras el timeout). Aquí los
   * listeners son propios y se quitan siempre en el finally.
   */
  private async runTestConnectionJob(type: string, ip: string, port: number): Promise<boolean> {
    const timeoutMs = Number(process.env.DEVICE_TEST_TIMEOUT_MS) || 5000;
    let job: Job<TestConnectionJobData>;
    try {
      job = await this.deviceOpsQueue.add(
        'test-connection',
        { type, ip, port },
        // Se conserva el resultado unos segundos para poder leerlo por estado
        // si el evento global llega antes de suscribirse (o se pierde).
        { attempts: 1, removeOnComplete: { age: 60 }, removeOnFail: { age: 60 } },
      );
    } catch (err) {
      this.logger.warn(`test-connection ${type} ${ip}:${port} falló: ${(err as Error).message}`);
      return false;
    }

    try {
      return await this.waitForJobResult(job, timeoutMs);
    } catch (err) {
      this.logger.warn(`test-connection ${type} ${ip}:${port} falló: ${(err as Error).message}`);
      return false;
    }
  }

  private async waitForJobResult(job: Job<TestConnectionJobData>, timeoutMs: number): Promise<boolean> {
    const queue = this.deviceOpsQueue;
    const jobId = String(job.id);
    let timer: NodeJS.Timeout | undefined;
    let onCompleted: ((id: unknown, result: unknown) => void) | undefined;
    let onFailed: ((id: unknown, reason: unknown) => void) | undefined;

    try {
      return await new Promise<boolean>((resolve, reject) => {
        onCompleted = (id, result) => {
          if (String(id) === jobId) resolve(parseJobResult(result));
        };
        onFailed = (id, reason) => {
          if (String(id) === jobId) reject(new Error(String(reason)));
        };
        queue.on('global:completed', onCompleted);
        queue.on('global:failed', onFailed);

        timer = setTimeout(() => {
          // Último chequeo por estado antes de dar el test por fallido.
          this.settleOnTimeout(job, timeoutMs).then(resolve, reject);
        }, timeoutMs);

        // Cierra la carrera: el job pudo terminar antes de suscribirse.
        this.readFinishedResult(job).then(
          (finished) => {
            if (!finished) return;
            if (finished.ok) resolve(finished.value);
            else reject(new Error(finished.reason));
          },
          () => undefined, // el timeout decide
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (onCompleted) queue.removeListener('global:completed', onCompleted);
      if (onFailed) queue.removeListener('global:failed', onFailed);
    }
  }

  private async readFinishedResult(
    job: Job<TestConnectionJobData>,
  ): Promise<{ ok: true; value: boolean } | { ok: false; reason: string } | undefined> {
    const state = await job.getState();
    if (state !== 'completed' && state !== 'failed') return undefined;
    const fresh = (await this.deviceOpsQueue.getJob(job.id)) ?? job;
    if (state === 'completed') return { ok: true, value: Boolean(fresh.returnvalue) };
    return { ok: false, reason: fresh.failedReason ?? 'job failed' };
  }

  private async settleOnTimeout(job: Job<TestConnectionJobData>, timeoutMs: number): Promise<boolean> {
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      const finished = await this.readFinishedResult(job);
      if (finished?.ok) return finished.value;
      throw new Error(finished?.reason ?? 'job failed');
    }
    // Solo se retira si nadie lo ha tomado; si está activo, el worker lo termina
    // y removeOnComplete/removeOnFail lo limpian.
    if (state === 'waiting' || state === 'delayed' || state === 'paused') {
      try {
        await job.remove();
      } catch {
        // best-effort
      }
    }
    throw new Error(`timeout tras ${timeoutMs}ms (estado: ${state})`);
  }
}

function parseJobResult(result: unknown): boolean {
  if (typeof result === 'string') {
    try {
      return Boolean(JSON.parse(result));
    } catch {
      return false;
    }
  }
  return Boolean(result);
}
