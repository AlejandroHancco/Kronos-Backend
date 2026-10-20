import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Namespace, Server, Socket } from 'socket.io';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WsAuthService } from '../auth/ws-auth.service';
import { getSocketUser, socketAuthMiddleware, WS_AUTH_ERROR } from '../auth/ws-socket';
import { PASSWORD_CHANGED_MESSAGE } from '../auth/jwt-user';
import { SessionEventsService } from '../common/session-events.service';

/**
 * Gateway de progreso de mediciones (namespace /measurements). Autentica en el handshake con un
 * middleware de namespace (rechazo → `connect_error`). Sala personal `{userId}`; la pertenencia
 * es una foto al momento de conectar y no se reevalúa hasta reconectar.
 */
@WebSocketGateway({
  namespace: 'measurements',
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  },
})
@Injectable()
export class MeasurementsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(MeasurementsGateway.name);
  private unsubscribeSessionEvents?: () => void;

  @WebSocketServer() server: Server;

  constructor(
    private readonly wsAuth: WsAuthService,
    private readonly sessionEvents: SessionEventsService,
  ) {}

  afterInit(server: Namespace) {
    // Autenticación en el handshake (antes de enviar CONNECT): el rechazo llega como connect_error.
    server.use(socketAuthMiddleware(this.wsAuth, this.logger));

    // Cambio de contraseña → cerrar en vivo los sockets del usuario
    this.unsubscribeSessionEvents = this.sessionEvents.onUserSessionsRevoked((userId) => {
      this.server.to(userId).emit(WS_AUTH_ERROR, { message: PASSWORD_CHANGED_MESSAGE });
      this.server.in(userId).disconnectSockets(true);
    });
    this.logger.log('✅ WebSocket Gateway initialized');
  }

  onModuleDestroy() {
    this.unsubscribeSessionEvents?.();
  }

  /** El middleware ya autenticó el socket; aquí solo se une a su sala personal `{userId}`. */
  handleConnection(socket: Socket) {
    const user = getSocketUser(socket);
    if (!user) {
      socket.disconnect(true);
      return;
    }
    socket.join(user.id);
    this.logger.log(`👤 Client connected: ${socket.id} (user ${user.id})`);
  }

  handleDisconnect(socket: Socket) {
    this.logger.log(`👤 Client disconnected: ${socket.id}`);
  }

  /**
   * Compatibilidad: socket.emit('join', userId). El userId del cuerpo se ignora;
   * el socket solo puede estar en su propia sala (idempotente).
   */
  @SubscribeMessage('join')
  async handleJoin(@ConnectedSocket() socket: Socket) {
    const user = getSocketUser(socket);
    if (!user) return;
    socket.join(user.id);
  }

  /**
   * Emitir progreso de medición a usuario específico
   * Se llama desde measurements.service.ts durante cada canal
   */
  emitMeasurementProgress(
    userId: string,
    jobId: string,
    channel: number,
    total: number,
    progress: number,
    message: string,
  ) {
    this.server.to(userId).emit('measurement:progress', {
      jobId,
      channel,
      total,
      percent: progress,
      status: 'measuring',
      message,
    });
    this.logger.debug(
      `📊 Progress emitted - User: ${userId}, Channel: ${channel}/${total} (${progress}%)`,
    );
  }

  /**
   * Emitir finalización de medición
   */
  emitMeasurementCompleted(
    userId: string,
    jobId: string,
    measurementId: number,
    takenAt: Date,
    totalPoints: number,
    data: any,
  ) {
    this.server.to(userId).emit('measurement:completed', {
      jobId,
      measurementId,
      takenAt,
      totalPoints,
      data,
    });
    this.logger.log(
      `✅ Measurement completed - User: ${userId}, ID: ${measurementId}, Points: ${totalPoints}`,
    );
  }

  /**
   * Emitir error de medición
   */
  emitMeasurementError(userId: string, jobId: string, message: string) {
    this.server.to(userId).emit('measurement:error', {
      jobId,
      message,
    });
    this.logger.error(
      `❌ Measurement error - User: ${userId}, Message: ${message}`,
    );
  }
}

