import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { NormalizedUser } from './interfaces/auth.interface';
import { PrismaService } from '@app/database';

interface SupabaseJwtPayload {
  sub: string;
  email?: string;
  email_confirmed_at?: string | null;
  user_metadata?: { full_name?: string; [key: string]: any };
  app_metadata?: { provider?: string; providers?: string[]; [key: string]: any };
  [key: string]: any;
}

/**
 * `app_metadata` solo lo escribe Supabase (no el usuario), así que es fiable para
 * saber si la identidad viene de Google. `user_metadata` NO se usa para decisiones
 * de confianza: el propio usuario puede modificarlo con `auth.updateUser({ data })`.
 */
function isGoogleIdentity(payload: SupabaseJwtPayload): boolean {
  const meta = payload.app_metadata;
  return (
    meta?.provider === 'google' ||
    (Array.isArray(meta?.providers) && meta.providers.includes('google'))
  );
}

function hasConfirmedEmail(payload: SupabaseJwtPayload): boolean {
  return typeof payload.email_confirmed_at === 'string' && payload.email_confirmed_at.length > 0;
}

@Injectable()
export class SupabaseStrategy extends PassportStrategy(Strategy, 'supabase') {
  private readonly logger = new Logger(SupabaseStrategy.name);
  private supabase: SupabaseClient;
  private readonly jwtSecret?: string;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super();

    const supabaseUrl = configService.get<string>('SUPABASE_URL')!;
    const supabaseKey = configService.get<string>('SUPABASE_SERVICE_ROLE_KEY')!;

    this.supabase = createClient(supabaseUrl, supabaseKey);

    // Supabase → Settings → API → JWT Secret. Si está configurado, la
    // verificación es local (sin round-trip a Supabase en cada request).
    this.jwtSecret = configService.get<string>('SUPABASE_JWT_SECRET');
    if (!this.jwtSecret) {
      this.logger.warn(
        'SUPABASE_JWT_SECRET no configurado — usando verificación remota (más lenta)',
      );
    }
  }

  async validate(req: Request): Promise<NormalizedUser> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('No token provided');
    }

    const token = authHeader.split(' ')[1];
    return this.validateToken(token);
  }

  /** Valida un token de Supabase (HTTP y WebSocket) y devuelve el usuario de la DB propia. */
  async validateToken(token: string): Promise<NormalizedUser> {
    const payload = await this.verifyToken(token);

    if (!payload?.email) {
      throw new UnauthorizedException('Invalid token');
    }

    // Solo se acepta una identidad de Supabase cuyo email esté probado: Google
    // (ya verificó el email) o un email confirmado. Sin esto, cualquiera podría
    // registrarse en Supabase con un email ajeno y entrar como su dueño.
    const google = isGoogleIdentity(payload);
    if (!google && !hasConfirmedEmail(payload)) {
      throw new UnauthorizedException('Debes confirmar tu email antes de iniciar sesión');
    }

    // Buscar o crear usuario en DB propia
    let dbUser = await this.prisma.user.findUnique({
      where: { email: payload.email },
    });

    // El superadministrador solo entra con su contraseña (JWT propio), nunca vía Supabase.
    if (dbUser?.isPlatformAdmin) {
      throw new UnauthorizedException('Esta cuenta debe iniciar sesión con contraseña');
    }

    if (!dbUser) {
      dbUser = await this.prisma.user.create({
        data: {
          email: payload.email,
          name: payload.user_metadata?.full_name?.split(' ')[0] || '',
          lastName:
            payload.user_metadata?.full_name?.split(' ').slice(1).join(' ') || '',
          password: '', // Sin contraseña: la identidad la gestiona Supabase
          provider: google ? 'google' : 'supabase',
          emailVerified: true, // Google o email confirmado (comprobado arriba)
          banned: false,
          rejectionCount: 0,
        },
      });
    }

    // Verificar si está baneado
    if (dbUser.banned) {
      throw new UnauthorizedException('Tu cuenta ha sido suspendida');
    }

    return {
      id: dbUser.uuid,
      email: dbUser.email,
      role: undefined,
      provider: 'supabase',
    };
  }

  /**
   * Verificación del token:
   * 1. Local con SUPABASE_JWT_SECRET (rápida, sin red).
   * 2. Fallback remoto (supabase.auth.getUser) si no hay secret
   *    o si la verificación local falla (p.ej. proyecto con claves asimétricas).
   *    También se consulta en remoto cuando el token local no prueba la identidad
   *    (ni Google ni claim `email_confirmed_at`): el access token de Supabase no
   *    trae la fecha de confirmación, y `user_metadata.email_verified` no es fiable.
   */
  private async verifyToken(token: string): Promise<SupabaseJwtPayload> {
    if (this.jwtSecret) {
      try {
        const local = jwt.verify(token, this.jwtSecret) as SupabaseJwtPayload;
        if (isGoogleIdentity(local) || hasConfirmedEmail(local)) return local;
      } catch (err) {
        this.logger.debug(
          `Verificación local falló (${err.message}) — intentando verificación remota`,
        );
      }
    }

    const {
      data: { user },
      error,
    } = await this.supabase.auth.getUser(token);

    if (error || !user) {
      throw new UnauthorizedException('Invalid token');
    }

    return {
      sub: user.id,
      email: user.email,
      email_confirmed_at: user.email_confirmed_at ?? null,
      user_metadata: user.user_metadata as { full_name?: string },
      app_metadata: user.app_metadata as { provider?: string; providers?: string[] },
    };
  }
}
