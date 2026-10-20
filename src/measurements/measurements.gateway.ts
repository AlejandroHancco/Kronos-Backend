import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { WsAuthService } from '../auth/ws-auth.service';
import { authenticateSocket, getSocketUser, WS_AUTH_ERROR } from '../auth/ws-socket';
import { PASSWORD_CHANGED_MESSAGE } from '../auth/jwt-user';
import { SessionEventsService } from '../common/session-events.service';

@WebSocketGateway({
  namespace: 'measurements',
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  },
})
@Injectable()
export class MeasurementsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(MeasurementsGateway.name);

  @WebSocketServer() server: Server;

  constructor(
    private readonly wsAuth: WsAuthService,
    private readonly sessionEvents: SessionEventsService,
  ) {}

  afterInit() {
    // Cambio de contraseña → cerrar en vivo los sockets del usuario
    this.sessionEvents.onUserSessionsRevoked((userId) => {
      this.server.to(userId).emit(WS_AUTH_ERROR, { message: PASSWORD_CHANGED_MESSAGE });
      this.server.in(userId).disconnectSockets(true);
    });
    this.logger.log('✅ WebSocket Gateway initialized');
  }

  /** Requiere `auth: { token }` en el handshake; une al socket a su sala personal `{userId}`. */
  async handleConnection(socket: Socket) {
    const user = await authenticateSocket(socket, this.wsAuth, this.logger);
    if (!user) return;
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
    const user = await getSocketUser(socket);
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

