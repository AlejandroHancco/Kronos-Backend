import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

type RevokeListener = (userId: string) => void;

/**
 * Bus mínimo de eventos de sesión. Existe para que AuthService pueda pedir la
 * desconexión de los sockets de un usuario sin depender de los gateways
 * (los gateways dependen de AuthModule para autenticar; la dependencia inversa
 * crearía un ciclo AuthModule ↔ MeasurementsModule).
 */
@Injectable()
export class SessionEventsService {
  private readonly logger = new Logger(SessionEventsService.name);
  private readonly emitter = new EventEmitter();

  /** Registra un listener; devuelve una función para darlo de baja. */
  onUserSessionsRevoked(listener: RevokeListener): () => void {
    this.emitter.on('revoked', listener);
    return () => this.emitter.off('revoked', listener);
  }

  /** Pide a todos los gateways que desconecten los sockets del usuario. */
  revokeUserSessions(userId: string): void {
    for (const listener of this.emitter.listeners('revoked') as RevokeListener[]) {
      try {
        listener(userId);
      } catch (err) {
        this.logger.error(`Error desconectando sockets de ${userId}: ${(err as Error).message}`);
      }
    }
  }
}
