import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { MemberStatus } from '@prisma/client';
import { PermissionsService } from '../permissions/permissions.service';

const ROLE_TEAM_ADMIN_ID = 2; // Administrador de Equipo
const ROLE_OPERATOR_ID = 4; // Operario (default para miembros degradados)

export type TeamAdminRole = 'ADMIN' | 'MEMBER';

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
  constructor(
    private prisma: PrismaService,
    private permissionsService: PermissionsService,
  ) {}

  /** Fija el rol del usuario en el equipo y propaga el rol de proyecto correspondiente. */
  async setTeamRole(teamId: string, userId: string, role: TeamAdminRole): Promise<void> {
    await this.memberUpsert(teamId, userId, role);
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

      await this.prisma.$transaction([
        this.prisma.teamMember.deleteMany({
          where: {
            userId,
            teamId: { not: grant.teamId },
            status: { in: [MemberStatus.PENDING, MemberStatus.REJECTED] },
          },
        }),
        this.memberUpsert(grant.teamId, userId, 'ADMIN'),
        this.prisma.teamAdminGrant.update({
          where: { id: grant.id },
          data: { claimedAt: new Date(), claimedById: userId },
        }),
      ]);
      await this.propagateRoleToProjects(grant.teamId, userId, 'ADMIN');
      await this.permissionsService.invalidateUserCache(userId);
      // El usuario solo puede pertenecer a un equipo: el resto queda abierto.
      return 1;
    }
    return 0;
  }

  private memberUpsert(teamId: string, userId: string, role: TeamAdminRole) {
    const data =
      role === 'ADMIN'
        ? { role, status: MemberStatus.APPROVED }
        : { role };
    return this.prisma.teamMember.upsert({
      where: { userId_teamId: { userId, teamId } },
      update: data,
      create: { userId, teamId, role, status: MemberStatus.APPROVED },
    });
  }

  private async propagateRoleToProjects(teamId: string, userId: string, role: TeamAdminRole) {
    const roleId = role === 'ADMIN' ? ROLE_TEAM_ADMIN_ID : ROLE_OPERATOR_ID;
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
