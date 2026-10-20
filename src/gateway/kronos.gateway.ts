import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Namespace, Server, Socket } from 'socket.io';
import { ForbiddenException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WsAuthService } from '../auth/ws-auth.service';
import { getSocketUser, socketAuthMiddleware, WS_AUTH_ERROR } from '../auth/ws-socket';
import { PASSWORD_CHANGED_MESSAGE } from '../auth/jwt-user';
import { TeamScopeService } from '../common/team-scope.service';
import { SessionEventsService } from '../common/session-events.service';

export interface JobStatusPayload {
  jobId: string;
  taskId?: number;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'retrying';
  attempt?: number;
  error?: string;
}

/**
 * Gateway principal de tiempo real (namespace /kronos).
 * Requiere `auth: { token }` en el handshake (mismas reglas que HTTP), verificado por un
 * middleware de namespace: un token inválido se rechaza con `connect_error` sin llegar a conectar.
 * - Sala `user:{userId}`  → estado de jobs y notificaciones personales (unión automática)
 * - Sala `team:{teamId}`  → estado de dispositivos del equipo (unión automática)
 * - Sala `task:{taskId}`  → updates de mediciones de una tarea del equipo del usuario
 *
 * La pertenencia a salas es una foto al momento de conectar: si el usuario cambia de equipo o
 * pierde acceso a una tarea, no se reevalúa hasta que el socket se reconecte.
 */
@WebSocketGateway({
  namespace: 'kronos',
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  },
})
@Injectable()
export class KronosGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(KronosGateway.name);
  private unsubscribeSessionEvents?: () => void;

  @WebSocketServer() server: Server;

  constructor(
    private readonly wsAuth: WsAuthService,
    private readonly teamScope: TeamScopeService,
    private readonly sessionEvents: SessionEventsService,
  ) {}

  afterInit(server: Namespace) {
    // Autenticación en el handshake (antes de enviar CONNECT): el rechazo llega como connect_error.
    server.use(socketAuthMiddleware(this.wsAuth, this.logger));

    // Cambio de contraseña → cerrar en vivo los sockets del usuario
    this.unsubscribeSessionEvents = this.sessionEvents.onUserSessionsRevoked((userId) => {
      const room = `user:${userId}`;
      this.server.to(room).emit(WS_AUTH_ERROR, { message: PASSWORD_CHANGED_MESSAGE });
      this.server.in(room).disconnectSockets(true);
    });
  }

  onModuleDestroy() {
    this.unsubscribeSessionEvents?.();
  }

  /** El middleware ya autenticó el socket; aquí solo se une a sus salas (foto al conectar). */
  async handleConnection(socket: Socket) {
    const user = getSocketUser(socket);
    if (!user) {
      // No debería ocurrir (el middleware rechaza antes); por si acaso, no dejar un socket anónimo.
      socket.disconnect(true);
      return;
    }
    socket.join(`user:${user.id}`);
    try {
      const teamId = await this.teamScope.getTeamId(user.id);
      socket.join(`team:${teamId}`);
    } catch (err) {
      if (!(err instanceof ForbiddenException)) {
        this.logger.error(
          `No se pudo unir el socket ${socket.id} a la sala de equipo (user ${user.id})`,
          err instanceof Error ? err.stack : err,
        );
      }
      // Usuario sin equipo aprobado (Forbidden): no bloquea la conexión, solo no recibe eventos de equipo.
    }
    this.logger.log(`Client connected: ${socket.id} (user ${user.id})`);
  }

  handleDisconnect(socket: Socket) {
    this.logger.log(`Client disconnected: ${socket.id}`);
  }

  /**
   * Compatibilidad: socket.emit('join', userId). El userId del cuerpo se ignora;
   * el socket solo puede estar en su propia sala (idempotente).
   */
  @SubscribeMessage('join')
  async handleJoin(@ConnectedSocket() socket: Socket) {
    const user = getSocketUser(socket);
    if (!user) return;
    socket.join(`user:${user.id}`);
  }

  /** Frontend: socket.emit('join-task', taskId) → solo tareas del equipo del usuario */
  @SubscribeMessage('join-task')
  async handleJoinTask(@ConnectedSocket() socket: Socket, @MessageBody() taskId: number | string) {
    const user = getSocketUser(socket);
    if (!user) return;
    const id = Number(taskId);
    try {
      if (!Number.isInteger(id)) throw new Error('invalid task id');
      await this.teamScope.assertTaskInTeam(user.id, id);
    } catch {
      socket.emit(WS_AUTH_ERROR, { message: 'No tienes acceso a esta tarea' });
      return;
    }
    socket.join(`task:${id}`);
    this.logger.log(`Socket ${socket.id} joined task room ${id}`);
  }

  /** Frontend: socket.emit('leave-task', taskId) */
  @SubscribeMessage('leave-task')
  async handleLeaveTask(@ConnectedSocket() socket: Socket, @MessageBody() taskId: number | string) {
    const user = getSocketUser(socket);
    if (!user) return;
    socket.leave(`task:${Number(taskId)}`);
  }

  /** Emite a todos los clientes suscritos a la tarea cuando termina una medición */
  emitMeasurementComplete(taskId: number, data: any) {
    this.server.to(`task:${taskId}`).emit('measurement:complete', { taskId, ...data });
    this.logger.log(`measurement:complete emitted to task:${taskId}`);
  }

  /** Notifica el estado del job (queued/processing/completed/failed/retrying) al usuario */
  emitJobStatus(userId: string, status: JobStatusPayload) {
    this.server.to(`user:${userId}`).emit('job:status', status);
    this.logger.debug(`job:status ${status.status} emitted to user:${userId}`);
  }

  /** Notificación in-app en tiempo real */
  emitNotification(userId: string, notification: any) {
    this.server.to(`user:${userId}`).emit('notification', notification);
    this.logger.log(`notification emitted to user:${userId}`);
  }

  /** Cambio de estado online/offline de un dispositivo: solo a los equipos del proyecto */
  async emitDeviceStatusChanged(deviceId: string, projectId: string, status: string) {
    const teamIds = await this.teamScope.teamIdsForProject(projectId);
    for (const teamId of teamIds) {
      this.server.to(`team:${teamId}`).emit('device:status', { deviceId, projectId, status });
    }
    this.logger.log(`device:status ${status} emitted for device ${deviceId} to ${teamIds.length} team(s)`);
  }
}
