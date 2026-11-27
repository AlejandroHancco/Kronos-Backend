import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { MemberStatus, Prisma } from '@prisma/client';
import { PermissionsService } from '../permissions/permissions.service';

export const ROLE_TEAM_ADMIN_ID = 2; // Administrador de Equipo
export const ROLE_OPERATOR_ID = 4; // Operario (default para miembros degradados)

export type TeamAdminRole = 'ADMIN' | 'MEMBER';

/** Rol de proyecto que corresponde a un rol de equipo. */
export function projectRoleIdFor(role: TeamAdminRole): number {
  return role === 'ADMIN' ? ROLE_TEAM_ADMIN_ID : ROLE_OPERATOR_ID;
}

export interface AdminCandidate {
  uuid: string;
  banned: boolean;
  isPlatformAdmin: boolean;
}

/**
 * Lógica compartida para nombrar/degradar administradores de equipo y para
 * aplicar invitaciones de administrador (TeamAdminGrant) pendientes.
 */
@Injectable()
export class TeamAdminService {
  private readonly logger = new Logger(TeamAdminService.name);

  constructor(
    private prisma: PrismaService,
    private permissionsService: PermissionsService,
  ) {}

  /**
   * Fija el rol del usuario en el equipo y propaga el rol de proyecto correspondiente.
   * ADMIN crea o aprueba la membresía; MEMBER exige una membresía existente.
   */
  async setTeamRole(teamId: string, userId: string, role: TeamAdminRole): Promise<void> {
    if (role === 'ADMIN') {
      await this.adminUpsert(this.prisma, teamId, userId);
    } else {
      const { count } = await this.prisma.teamMember.updateMany({
        where: { userId, teamId },
        data: { role: 'MEMBER' },
      });
      if (count === 0) throw new NotFoundException('Miembro no encontrado en el equipo');
    }
    await this.propagateRoleToProjects(teamId, userId, role);
    await this.permissionsService.invalidateUserCache(userId);
  }

  /** Motivo por el que el usuario no puede ser ADMIN de `teamId`, o null si puede. */
  async adminBlockReason(user: AdminCandidate, teamId: string): Promise<string | null> {
    if (user.banned) return 'cuenta suspendida';
    if (user.isPlatformAdmin) return 'es superadministrador';
    const other = await this.prisma.teamMember.findFirst({
      where: { userId: user.uuid, status: MemberStatus.APPROVED, teamId: { not: teamId } },
      include: { team: { select: { name: true } } },
    });
    if (other) return `ya pertenece a ${other.team.name}`;
    return null;
  }

  /**
   * Aplica como máximo una invitación abierta cuyo email coincida (sin distinguir
   * mayúsculas) con el del usuario verificado. Nunca lanza por "nada que hacer".
   * @returns número de invitaciones aplicadas (0 o 1).
   */
  async claimPendingGrants(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { uuid: userId },
      select: { uuid: true, email: true, emailVerified: true, banned: true, isPlatformAdmin: true },
    });
    if (!user || !user.emailVerified || !user.email) return 0;

    const grants = await this.prisma.teamAdminGrant.findMany({
      where: { email: user.email.toLowerCase(), claimedAt: null, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    for (const grant of grants) {
      if (await this.adminBlockReason(user, grant.teamId)) continue;

      const claimed = await this.prisma.$transaction(async (tx) => {
        // Marcar primero: si otra petición ya la reclamó o fue revocada, no tocar nada.
        const { count } = await tx.teamAdminGrant.updateMany({
          where: { id: grant.id, claimedAt: null, revokedAt: null },
          data: { claimedAt: new Date(), claimedById: userId },
        });
        if (count === 0) return false;
        await tx.teamMember.deleteMany({
          where: {
            userId,
            teamId: { not: grant.teamId },
            status: { in: [MemberStatus.PENDING, MemberStatus.REJECTED] },
          },
        });
        await this.adminUpsert(tx, grant.teamId, userId);
        return true;
      });
      if (!claimed) continue;

      try {
        await this.propagateRoleToProjects(grant.teamId, userId, 'ADMIN');
        await this.permissionsService.invalidateUserCache(userId);
      } catch (err) {
        this.logger.error(
          `Grant ${grant.id} reclamado por ${userId}, pero falló la propagación de roles/caché`,
          err instanceof Error ? err.stack : String(err),
        );
      }
      // El usuario solo puede pertenecer a un equipo: el resto queda abierto.
      return 1;
    }
    return 0;
  }

  private adminUpsert(client: Prisma.TransactionClient, teamId: string, userId: string) {
    return client.teamMember.upsert({
      where: { userId_teamId: { userId, teamId } },
      update: { role: 'ADMIN', status: MemberStatus.APPROVED },
      create: { userId, teamId, role: 'ADMIN', status: MemberStatus.APPROVED },
    });
  }

  private async propagateRoleToProjects(teamId: string, userId: string, role: TeamAdminRole) {
    const roleId = projectRoleIdFor(role);
    const teamMemberIds = await this.prisma.teamMember.findMany({
      where: { teamId, status: MemberStatus.APPROVED },
      select: { userId: true },
    });
    const memberUserIds = teamMemberIds.map((m) => m.userId);

    const teamProjects = await this.prisma.project.findMany({
      where: { userProjectRoles: { some: { userId: { in: memberUserIds } } } },
      select: { uuid: true },
    });

    await Promise.all(
      teamProjects.map((p) =>
        this.prisma.userProjectRole.upsert({
          where: { userId_projectId: { userId, projectId: p.uuid } },
          update: { roleId },
          create: { userId, projectId: p.uuid, roleId },
        }),
      ),
    );
  }
}
