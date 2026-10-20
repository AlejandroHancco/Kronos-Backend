import { Logger, UnauthorizedException } from '@nestjs/common';
import { Socket } from 'socket.io';
import { NormalizedUser } from './interfaces/auth.interface';
import { WsAuthService } from './ws-auth.service';

/**
 * Evento que recibe un socket YA conectado cuando se le revoca la sesión (cambio de contraseña)
 * o se le niega una acción (p. ej. `join-task` fuera del equipo). El rechazo del handshake NO
 * usa este evento: llega al cliente como `connect_error` (ver `socketAuthMiddleware`).
 */
export const WS_AUTH_ERROR = 'auth:error';

/** Error que socket.io entrega al cliente como `connect_error` (`err.message` y `err.data`). */
export interface WsAuthRejection extends Error {
  data: { message: string };
}

/**
 * Middleware de namespace: autentica con `handshake.auth.token` ANTES de que socket.io envíe el
 * paquete CONNECT. Si falla, el cliente recibe `connect_error` (nunca `connect`), de modo que su
 * máquina de reintentos no confunde un rechazo con una conexión aceptada.
 * Si tiene éxito deja el usuario en `socket.data.user`.
 */
export function socketAuthMiddleware(wsAuth: WsAuthService, logger: Logger) {
  return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
    try {
      socket.data.user = await wsAuth.authenticate(socket.handshake.auth?.token);
      next();
    } catch (err) {
      const message =
        err instanceof UnauthorizedException ? err.message : 'Invalid or missing token';
      logger.warn(`Socket ${socket.id} rejected: ${message}`);
      const rejection = new Error(message) as WsAuthRejection;
      rejection.data = { message };
      next(rejection);
    }
  };
}

/** Usuario autenticado del socket (el middleware garantiza que existe tras conectar) o null. */
export function getSocketUser(socket: Socket): NormalizedUser | null {
  return (socket.data?.user as NormalizedUser | undefined) ?? null;
}
