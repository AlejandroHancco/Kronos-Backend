import { randomInt } from 'crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@app/database';
import { MemberStatus, Prisma } from '@prisma/client';
import { TeamAdminService } from '../teams/team-admin.service';
import { MailService } from '../mail/mail.service';
import { buildAdminNoticeEmail } from './admin-notice-email';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_ATTEMPTS = 5;

export type GrantStatus = 'pending' | 'pending_verification' | 'blocked';
export type AddAdminStatus = 'admin' | 'pending' | 'pending_verification';

export interface PlatformGrantView {
  id: string;
  email: string;
  createdAt: Date;
  status: GrantStatus;
  reason?: string;
}

export interface PlatformTeamView {
  id: string;
  name: string;
  code: string;
  createdAt: Date;
  memberCount: number;
  admins: Array<{ userId: string; name: string; email: string }>;
  grants: PlatformGrantView[];
}

interface ExistingUser {
  uuid: string;
  name: string;
  email: string;
  emailVerified: boolean;
  banned: boolean;
  isPlatformAdmin: boolean;
}

const USER_SELECT = {
  uuid: true,
  name: true,
  email: true,
  emailVerified: true,
  banned: true,
  isPlatformAdmin: true,
} as const;

const OPEN_GRANT = { claimedAt: null, revokedAt: null } as const;

export function generateTeamCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Gestión de grupos de investigación y sus administradores (solo superadministrador). */
@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly teamAdmin: TeamAdminService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async listTeams(): Promise<PlatformTeamView[]> {
    const teams = await this.prisma.team.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { members: { where: { status: MemberStatus.APPROVED } } } },
        members: {
          where: { role: 'ADMIN', status: MemberStatus.APPROVED },
          orderBy: { createdAt: 'asc' },
          select: { user: { select: { uuid: true, name: true, email: true } } },
        },
        adminGrants: {
          where: OPEN_GRANT,
          orderBy: { createdAt: 'asc' },
          select: { id: true, email: true, createdAt: true },
        },
      },
    });

    const emails = [...new Set(teams.flatMap((t) => t.adminGrants.map((g) => g.email.toLowerCase())))];
    const users = emails.length
      ? await this.prisma.user.findMany({
          where: { OR: emails.map((e) => ({ email: { equals: e, mode: 'insensitive' as const } })) },
          select: USER_SELECT,
        })
      : [];
    const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u as ExistingUser]));

    return Promise.all(
      teams.map(async (t) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        createdAt: t.createdAt,
        memberCount: t._count.members,
        admins: t.members.map((m) => ({ userId: m.user.uuid, name: m.user.name, email: m.user.email })),
        grants: await Promise.all(
          t.adminGrants.map(async (g) => ({
            id: g.id,
            email: g.email,
            createdAt: g.createdAt,
            ...(await this.grantStatus(byEmail.get(g.email.toLowerCase()) ?? null, t.id)),
          })),
        ),
      })),
    );
  }

  async createTeam(
    dto: { name: string; code?: string; adminEmail: string },
    invitedById: string,
  ): Promise<PlatformTeamView> {
    const name = dto.name.trim();
    const email = normalizeEmail(dto.adminEmail);
    const user = await this.findUserByEmail(email);
    // El equipo aún no existe: cualquier membresía APPROVED cuenta como "otro grupo".
    if (user) await this.assertNotBlocked(user, '');
    const adminUser = user?.emailVerified ? user : null;

    const givenCode = dto.code?.trim().toUpperCase() || undefined;
    for (let attempt = 1; ; attempt++) {
      const code = givenCode ?? generateTeamCode();
      try {
        const { team, grant } = await this.prisma.$transaction(async (tx) => {
          const team = await tx.team.create({ data: { name, code } });
          if (adminUser) {
            await this.teamAdmin.makeAdminInTx(tx, team.id, adminUser.uuid);
            return { team, grant: null };
          }
          const grant = await tx.teamAdminGrant.create({ data: { email, teamId: team.id, invitedById } });
          return { team, grant };
        });

        if (adminUser) await this.applyAdminSideEffects(team.id, adminUser.uuid);
        await this.sendNotice(user ? user.email : email, team.name);

        return {
          id: team.id,
          name: team.name,
          code: team.code,
          createdAt: team.createdAt,
          memberCount: adminUser ? 1 : 0,
          admins: adminUser ? [{ userId: adminUser.uuid, name: adminUser.name, email: adminUser.email }] : [],
          grants: grant
            ? [
                {
                  id: grant.id,
                  email: grant.email,
                  createdAt: grant.createdAt,
                  status: user ? 'pending_verification' : 'pending',
                },
              ]
            : [],
        };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          if (givenCode) throw new ConflictException('El código ya está en uso por otro grupo');
          if (attempt < CODE_ATTEMPTS) continue;
          throw new ConflictException('No se pudo generar un código único; inténtalo de nuevo');
        }
        throw err;
      }
    }
  }

  async addAdmin(teamId: string, rawEmail: string, invitedById: string): Promise<{ status: AddAdminStatus }> {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Grupo no encontrado');

    const email = normalizeEmail(rawEmail);
    const user = await this.findUserByEmail(email);
    if (user) await this.assertNotBlocked(user, teamId);

    let status: AddAdminStatus;
    if (user && user.emailVerified) {
      // Mismo efecto que reclamar la invitación, en una sola transacción.
      await this.prisma.$transaction(async (tx) => {
        await tx.teamAdminGrant.updateMany({
          where: { email, teamId, ...OPEN_GRANT },
          data: { claimedAt: new Date(), claimedById: user.uuid },
        });
        await this.teamAdmin.makeAdminInTx(tx, teamId, user.uuid);
      });
      await this.applyAdminSideEffects(teamId, user.uuid);
      status = 'admin';
    } else {
      const open = await this.prisma.teamAdminGrant.findFirst({ where: { email, teamId, ...OPEN_GRANT } });
      if (!open) {
        try {
          await this.prisma.teamAdminGrant.create({ data: { email, teamId, invitedById } });
        } catch (err) {
          // Carrera con otra petición: el índice único parcial (una invitación abierta
          // por email+grupo) ya la tiene → mismo resultado que el camino idempotente.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        }
      }
      status = user ? 'pending_verification' : 'pending';
    }

    await this.sendNotice(user ? user.email : email, team.name);
    return { status };
  }

  async removeAdmin(teamId: string, userId: string): Promise<void> {
    const member = await this.prisma.teamMember.findFirst({
      where: { teamId, userId, role: 'ADMIN', status: MemberStatus.APPROVED },
    });
    if (!member) throw new NotFoundException('Administrador no encontrado en el grupo');

    const admins = await this.prisma.teamMember.count({
      where: { teamId, role: 'ADMIN', status: MemberStatus.APPROVED },
    });
    if (admins <= 1) throw new ConflictException('No se puede quitar al último administrador del grupo');

    await this.teamAdmin.setTeamRole(teamId, userId, 'MEMBER');
  }

  async revokeGrant(grantId: string): Promise<void> {
    const grant = await this.prisma.teamAdminGrant.findUnique({ where: { id: grantId } });
    if (!grant || grant.claimedAt || grant.revokedAt) throw new NotFoundException('Invitación no encontrada');

    const admins = await this.prisma.teamMember.count({
      where: { teamId: grant.teamId, role: 'ADMIN', status: MemberStatus.APPROVED },
    });
    if (admins === 0) {
      const openGrants = await this.prisma.teamAdminGrant.count({ where: { teamId: grant.teamId, ...OPEN_GRANT } });
      if (openGrants <= 1) {
        throw new ConflictException('No se puede revocar la única invitación de un grupo sin administradores');
      }
    }

    await this.prisma.teamAdminGrant.updateMany({
      where: { id: grantId, ...OPEN_GRANT },
      data: { revokedAt: new Date() },
    });
  }

  private findUserByEmail(email: string): Promise<ExistingUser | null> {
    return this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: USER_SELECT,
    });
  }

  private async assertNotBlocked(user: ExistingUser, teamId: string): Promise<void> {
    const reason = await this.teamAdmin.adminBlockReason(user, teamId);
    if (reason) {
      const detail = reason.startsWith('cuenta') ? reason : `la cuenta ${reason}`;
      throw new ConflictException(`No se puede: ${detail}`);
    }
  }

  private async grantStatus(
    user: ExistingUser | null,
    teamId: string,
  ): Promise<{ status: GrantStatus; reason?: string }> {
    if (!user) return { status: 'pending' };
    const reason = await this.teamAdmin.adminBlockReason(user, teamId);
    if (reason) return { status: 'blocked', reason };
    return { status: user.emailVerified ? 'pending' : 'pending_verification' };
  }

  /**
   * Roles de proyecto + caché tras el commit. Un fallo se registra y no deshace la asignación
   * (ni provoca un 500 que lleve a repetir la petición y duplicar el grupo).
   */
  private async applyAdminSideEffects(teamId: string, userId: string): Promise<void> {
    try {
      await this.teamAdmin.applyRoleSideEffects(teamId, userId, 'ADMIN');
    } catch (err) {
      this.logger.error(
        `${userId} es ADMIN de ${teamId}, pero falló la propagación de roles/caché`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Un fallo de envío se registra y no deshace la asignación. */
  private async sendNotice(to: string, teamName: string): Promise<void> {
    const appUrl = (this.config.get<string>('FRONTEND_URL') || 'http://localhost:5173').replace(/\/+$/, '');
    try {
      await this.mail.send({ to, ...buildAdminNoticeEmail(teamName, appUrl) });
    } catch (err) {
      this.logger.error(
        `No se pudo enviar el aviso de administrador a ${to} (${teamName})`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
