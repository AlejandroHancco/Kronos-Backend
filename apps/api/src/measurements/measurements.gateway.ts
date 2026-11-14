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
import { Injectable, Logger } from '@nestjs/common';

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

  afterInit(server: Server) {
    this.logger.log('✅ WebSocket Gateway initialized');
  }

  handleConnection(socket: Socket) {
    this.logger.log(`👤 Client connected: ${socket.id}`);
  }

  handleDisconnect(socket: Socket) {
    this.logger.log(`👤 Client disconnected: ${socket.id}`);
  }

  /**
   * Event 'join': Usuario se une a su sala personal
   * Frontend: socket.emit('join', userId)
   */
  @SubscribeMessage('join')
  handleJoin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() userId: string,
  ) {
    socket.join(userId);
    this.logger.log(
      `✅ User ${userId} joined their room - Socket ID: ${socket.id}`,
    );
  }
}
