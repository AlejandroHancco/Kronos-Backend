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
import { Server, Socket } from 'socket.io';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WsAuthService } from '../auth/ws-auth.service';
import { authenticateSocket, getSocketUser, WS_AUTH_ERROR } from '../auth/ws-socket';
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
 * Requiere `auth: { token }` en el handshake (mismas reglas que HTTP).
 * - Sala `user:{userId}`  → estado de jobs y notificaciones personales (unión automática)
 * - Sala `task:{taskId}`  → updates de mediciones de una tarea del equipo del usuario
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

  afterInit() {
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

  async handleConnection(socket: Socket) {
    const user = await authenticateSocket(socket, this.wsAuth, this.logger);
    if (!user) return;
    socket.join(`user:${user.id}`);
    try {
      const teamId = await this.teamScope.getTeamId(user.id);
      socket.join(`team:${teamId}`);
    } catch {
      // Usuario sin equipo aprobado: no bloquea la conexión, solo no recibe eventos de equipo.
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
    const user = await getSocketUser(socket);
    if (!user) return;
    socket.join(`user:${user.id}`);
  }

  /** Frontend: socket.emit('join-task', taskId) → solo tareas del equipo del usuario */
  @SubscribeMessage('join-task')
  async handleJoinTask(@ConnectedSocket() socket: Socket, @MessageBody() taskId: number | string) {
    const user = await getSocketUser(socket);
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
    const user = await getSocketUser(socket);
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
