import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { NormalizedUser } from './interfaces/auth.interface';
import { SupabaseStrategy } from './supabase.strategy';
import { assertJwtUserActive } from './jwt-user';

/**
 * Autenticación de sockets con las mismas reglas que HTTP (CombinedAuthGuard):
 * primero JWT propio (incluida la revocación por cambio de contraseña) y, si la
 * firma no es nuestra, token de Supabase.
 */
@Injectable()
export class WsAuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseStrategy,
  ) {}

  async authenticate(token: string | undefined): Promise<NormalizedUser> {
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException('No token provided');
    }

    let payload: { sub?: string; iat?: number } | undefined;
    try {
      payload = this.jwtService.verify(token);
    } catch (err) {
      // La firma se comprueba antes que la expiración: un token expirado es nuestro.
      if (err instanceof TokenExpiredError) {
        throw new UnauthorizedException('Token expired');
      }
    }

    if (payload) {
      // Errores de revocación/usuario inexistente se propagan tal cual (no se prueba Supabase).
      return assertJwtUserActive(this.prisma, payload);
    }

    try {
      return await this.supabase.validateToken(token);
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid or missing token');
    }
  }
}
