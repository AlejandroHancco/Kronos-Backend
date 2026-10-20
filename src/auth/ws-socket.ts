import { Logger, UnauthorizedException } from '@nestjs/common';
import { Socket } from 'socket.io';
import { NormalizedUser } from './interfaces/auth.interface';
import { WsAuthService } from './ws-auth.service';

/** Evento que recibe el cliente cuando se le niega la conexión o una acción. */
export const WS_AUTH_ERROR = 'auth:error';

/**
 * Autentica el socket con `handshake.auth.token`. Si falla, emite `auth:error`
 * y desconecta. Guarda la promesa en `socket.data.authReady` para que los
 * handlers que llegan antes de terminar la verificación la esperen.
 */
export function authenticateSocket(
  socket: Socket,
  wsAuth: WsAuthService,
  logger: Logger,
): Promise<NormalizedUser | null> {
  const ready = (async () => {
    try {
      const user = await wsAuth.authenticate(socket.handshake.auth?.token);
      socket.data.user = user;
      return user;
    } catch (err) {
      const message =
        err instanceof UnauthorizedException ? err.message : 'Invalid or missing token';
      logger.warn(`Socket ${socket.id} rejected: ${message}`);
      socket.emit(WS_AUTH_ERROR, { message });
      socket.disconnect(true);
      return null;
    }
  })();
  socket.data.authReady = ready;
  return ready;
}

/** Usuario autenticado del socket (espera la verificación en curso) o null. */
export async function getSocketUser(socket: Socket): Promise<NormalizedUser | null> {
  if (socket.data?.user) return socket.data.user as NormalizedUser;
  const ready = socket.data?.authReady as Promise<NormalizedUser | null> | undefined;
  return ready ? ready : null;
}
