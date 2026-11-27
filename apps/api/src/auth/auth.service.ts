import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@app/database';
import { PermissionsService } from '../permissions/permissions.service';
import { SessionEventsService } from '@app/common';
import * as bcrypt from 'bcrypt';
import { EmailVerificationService } from './email-verification.service';
import { TeamAdminService } from '../teams/team-admin.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private permissionsService: PermissionsService,
    private sessionEvents: SessionEventsService,
    private emailVerification: EmailVerificationService,
    private teamAdmin: TeamAdminService,
  ) {}

  async validateUser(email: string, password: string): Promise<any> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user && user.password && (await bcrypt.compare(password, user.password))) {
      const { password: _pw, ...result } = user;
      return result;
    }
    return null;
  }

  async login(user: any) {
    const payload = { name: user.name, sub: user.uuid };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  /** Reemite un JWT propio con expiración fresca, mientras el token actual siga siendo válido. */
  async refresh(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { uuid: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    return this.login(user);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { uuid: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    if (!user.password) {
      throw new BadRequestException('Tu cuenta usa Google; no tiene contraseña local');
    }
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      throw new BadRequestException('La contraseña actual es incorrecta');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException('La nueva contraseña debe ser distinta de la actual');
    }
    // bcrypt trunca/ignora silenciosamente lo que exceda 72 BYTES (no caracteres); con tildes o
    // ñ (2 bytes en UTF-8) un password de 72 caracteres puede superar ese límite.
    if (Buffer.byteLength(newPassword, 'utf8') > 72) {
      throw new BadRequestException('La nueva contraseña no puede superar 72 bytes (las letras con tilde o ñ cuentan doble)');
    }
    await this.prisma.user.update({
      where: { uuid: userId },
      data: { password: await bcrypt.hash(newPassword, 10), passwordChangedAt: new Date() },
    });
    // Cierra en vivo los sockets abiertos con tokens anteriores (ambos namespaces).
    // La sesión que hizo el cambio se reconecta con el token nuevo.
    this.sessionEvents.revokeUserSessions(userId);
    // Reemitimos un token fresco para que la sesión que hizo el cambio siga activa
    // mientras las demás quedan invalidadas por jwt.strategy.
    return { ok: true, ...(await this.login(user)) };
  }

  async register(email: string, name: string, lastName: string | undefined, password: string) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: {
        email,
        name,
        lastName,
        password: hashedPassword,
      },
    });
    try {
      await this.emailVerification.issueAndSend(user);
    } catch (err) {
      // Un fallo de envío no debe romper el registro; el usuario puede reenviar.
      this.logger.error(`No se pudo enviar el correo de verificación a ${user.email}: ${(err as Error).message}`);
    }
    return this.login(user);
  }

  async getProfile(uuid: string) {
    if (!uuid) {
      throw new UnauthorizedException('UUID no proporcionado');
    }

    // Reclama invitaciones de admin pendientes antes de leer membresías; nunca rompe el perfil.
    try {
      await this.teamAdmin.claimPendingGrants(uuid);
    } catch (err) {
      this.logger.error(`No se pudieron reclamar las invitaciones pendientes de ${uuid}: ${(err as Error).message}`);
    }

    const user = await this.prisma.user.findUnique({
      where: { uuid },
      select: {
        isPlatformAdmin: true,
        uuid: true,
        email: true,
        name: true,
        lastName: true,
        provider: true,
        emailVerified: true,
        banned: true,
        rejectionCount: true,
        createdAt: true,
        teamMembers: {
          include: { team: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    const membership = user.teamMembers[0] ?? null;
    const teamStatus: string = membership ? (membership.status as string) : 'PENDING_TEAM';

    const [permissions, roleNames] = await Promise.all([
      this.permissionsService.getUserPermissions(uuid),
      this.permissionsService.getUserRoleNames(uuid),
    ]);

    const { teamMembers, ...rest } = user;
    return {
      ...rest,
      teamStatus,
      team: membership
        ? { id: membership.team.id, name: membership.team.name, code: membership.team.code }
        : null,
      permissions,
      roleNames,
    };
  }
  async checkEmail(email: string): Promise<{
    exists: boolean;
    provider: 'password' | 'google' | null;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        email: true,
        password: true,
      },
    });

    if (!user) return { exists: false, provider: null };

    // En Supabase, si el usuario no tiene password, es porque usó un provider externo
    if (!user.password || user.password === '') return { exists: true, provider: 'google' };

    return { exists: true, provider: 'password' };
  }
}
