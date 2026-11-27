import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { PermissionsService } from '../permissions/permissions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TeamAdminService, projectRoleIdFor } from './team-admin.service';
import { TeamRole, MemberStatus } from '@prisma/client';
import { NormalizedUser } from '../auth/interfaces/auth.interface';
import { parseAcquisitionSnapshot } from '@app/laas-catalog';

const MAX_REJECTIONS     = 3;

@Injectable()
export class TeamsService {
  constructor(
    private prisma: PrismaService,
    private teamScope: TeamScopeService,
    private permissionsService: PermissionsService,
    private notificationsService: NotificationsService,
    private teamAdmin: TeamAdminService,
  ) {}

  async joinTeam(code: string, user: NormalizedUser) {
    const dbUser = await this.prisma.user.findUnique({ where: { uuid: user.id } });
    if (dbUser?.banned) throw new ForbiddenException('Tu cuenta ha sido suspendida');
    if (dbUser?.isPlatformAdmin) {
      throw new ForbiddenException('El superadministrador no puede unirse a un grupo');
    }

    // Los códigos se guardan en mayúsculas.
    const team = await this.prisma.team.findUnique({ where: { code: code.trim().toUpperCase() } });
    if (!team) throw new BadRequestException('Código inválido');

    const existing = await this.prisma.teamMember.findUnique({
      where: { userId_teamId: { userId: user.id, teamId: team.id } },
    });

    if (existing?.status === 'APPROVED') throw new BadRequestException('Ya eres miembro');

    // Un usuario pertenece a un solo grupo: no puede pedir entrar en otro.
    const otherMembership = await this.prisma.teamMember.findFirst({
      where: { userId: user.id, status: 'APPROVED', teamId: { not: team.id } },
      select: { id: true },
    });
    if (otherMembership) throw new BadRequestException('Ya perteneces a un grupo');

    if (existing) {
      await this.prisma.teamMember.update({
        where: { id: existing.id },
        data: { status: 'PENDING' },
      });
    } else {
      await this.prisma.teamMember.create({
        data: { userId: user.id, teamId: team.id, status: 'PENDING', role: 'MEMBER' },
      });
    }

    // Notificar a todos los admins del equipo sobre la nueva solicitud
    const admins = await this.prisma.teamMember.findMany({
      where: { teamId: team.id, role: 'ADMIN', status: 'APPROVED' },
      select: { userId: true },
    });
    const applicantName = dbUser
      ? `${dbUser.name}${dbUser.lastName ? ' ' + dbUser.lastName : ''}`
      : user.email;
    await Promise.all(
      admins.map((admin) =>
        this.notificationsService.notifyAdminNewRequest(admin.userId, team.id, applicantName, team.name),
      ),
    );

    return { message: 'Solicitud enviada', status: 'PENDING' };
  }

  async getMyStatus(user: NormalizedUser) {
    const dbUser = await this.prisma.user.findUnique({ where: { uuid: user.id } });
    if (!dbUser) throw new NotFoundException('Usuario no encontrado');

    const teamMember = await this.prisma.teamMember.findFirst({
      where: { userId: user.id },
      include: { team: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      status: (teamMember?.status as string) ?? 'NONE',
      rejectionCount: dbUser.rejectionCount,
      banned: dbUser.banned,
      team: teamMember?.team
        ? { id: teamMember.team.id, name: teamMember.team.name, code: teamMember.team.code }
        : null,
    };
  }

  async getPendingRequests(user: NormalizedUser) {
    const adminMember = await this.prisma.teamMember.findFirst({
      where: { userId: user.id, role: 'ADMIN', status: 'APPROVED' },
    });
    if (!adminMember) throw new ForbiddenException('No tienes permisos para ver solicitudes');

    const requests = await this.prisma.teamMember.findMany({
      where: { teamId: adminMember.teamId, status: 'PENDING' },
      include: {
        user: { select: { uuid: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return requests.map((m) => ({
      userId: m.user.uuid,
      userName: m.user.name,
      userEmail: m.user.email,
      status: m.status,
      createdAt: m.createdAt,
    }));
  }

  async getTeam(teamId: string, callerId: string) {
    await this.teamScope.assertTeamAccess(callerId, teamId);
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException(`Team ${teamId} not found`);
    return team;
  }

  async getMembers(teamId: string, callerId: string) {
    await this.teamScope.assertTeamAccess(callerId, teamId);
    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      include: {
        user: { select: { uuid: true, name: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((m) => ({
      userId: m.user.uuid,
      name: m.user.name,
      lastName: m.user.lastName,
      email: m.user.email,
      role: m.role,
      status: m.status,
    }));
  }

  async updateMemberRole(
    teamId: string,
    targetUserId: string,
    newRole: TeamRole,
    caller: NormalizedUser,
  ) {
    await this.teamScope.assertTeamAccess(caller.id, teamId);

    // 1. Verificar que el caller sea ADMIN del equipo
    const callerMember = await this.prisma.teamMember.findFirst({
      where: { teamId, userId: caller.id, role: 'ADMIN', status: 'APPROVED' },
    });
    if (!callerMember) {
      throw new ForbiddenException('Solo un ADMIN del equipo puede cambiar roles');
    }

    // 2. No permitir cambiar el propio rol
    if (targetUserId === caller.id) {
      throw new BadRequestException('No puedes cambiar tu propio rol');
    }

    // 3. Verificar que el target sea miembro del equipo
    const targetMember = await this.prisma.teamMember.findFirst({
      where: { teamId, userId: targetUserId },
    });
    if (!targetMember) throw new NotFoundException('Miembro no encontrado en el equipo');
    // Las solicitudes pendientes/rechazadas pasan por approveMember (notificación, etc.)
    if (targetMember.status !== MemberStatus.APPROVED) {
      throw new BadRequestException('Primero aprueba la solicitud de este miembro');
    }
    await this.assertNotPlatformAdmin(targetUserId);

    // 4. Actualizar TeamMember.role, propagar a UserProjectRole en los proyectos
    //    del equipo e invalidar la caché de permisos del usuario afectado
    await this.teamAdmin.setTeamRole(teamId, targetUserId, newRole);
    const projectRoleId = projectRoleIdFor(newRole);

    return {
      message: `Rol actualizado a ${newRole}`,
      userId: targetUserId,
      newTeamRole: newRole,
      newProjectRoleId: projectRoleId,
    };
  }

  async removeMember(teamId: string, userId: string, caller: NormalizedUser) {
    // Solo un ADMIN del mismo equipo puede remover miembros
    const callerAdmin = await this.prisma.teamMember.findFirst({
      where: { teamId, userId: caller.id, role: 'ADMIN', status: 'APPROVED' },
    });
    if (!callerAdmin) {
      throw new ForbiddenException('Solo un ADMIN del equipo puede remover miembros');
    }
    if (userId === caller.id) {
      throw new BadRequestException('No puedes removerte a ti mismo del equipo');
    }

    const member = await this.prisma.teamMember.findFirst({ where: { teamId, userId } });
    if (!member) throw new NotFoundException('Member not found');

    const removed = await this.prisma.teamMember.delete({ where: { id: member.id } });
    await this.permissionsService.invalidateUserCache(userId);
    return removed;
  }

  async approveMember(teamId: string, userId: string, adminUser: NormalizedUser) {
    const adminMember = await this.prisma.teamMember.findFirst({
      where: { userId: adminUser.id, role: 'ADMIN', status: 'APPROVED' },
    });
    if (!adminMember) throw new ForbiddenException('No tienes permisos para aprobar solicitudes');

    const memberToApprove = await this.prisma.teamMember.findFirst({
      where: { userId, teamId: adminMember.teamId },
    });
    if (!memberToApprove) throw new NotFoundException('Solicitud no encontrada');
    await this.assertNotPlatformAdmin(userId);

    const updated = await this.prisma.teamMember.update({
      where: { id: memberToApprove.id },
      data: { status: 'APPROVED' },
      include: { user: true, team: true },
    });

    // Invalidar caché de permisos + notificar al usuario aprobado
    await this.permissionsService.invalidateUserCache(userId);
    await this.notificationsService.notifyMemberApproved(userId, updated.team.id, updated.team.name);

    return {
      message: 'Solicitud aprobada',
      member: {
        userId: updated.user.uuid,
        userName: updated.user.name,
        status: updated.status,
      },
    };
  }

  /** Defensa en profundidad: el superadministrador nunca recibe rol dentro de un grupo. */
  private async assertNotPlatformAdmin(userId: string) {
    const target = await this.prisma.user.findUnique({
      where: { uuid: userId },
      select: { isPlatformAdmin: true },
    });
    if (target?.isPlatformAdmin) {
      throw new ForbiddenException('El superadministrador no puede tener rol en un grupo');
    }
  }

  async rejectMember(teamId: string, userId: string, adminUser: NormalizedUser) {
    const adminMember = await this.prisma.teamMember.findFirst({
      where: { userId: adminUser.id, role: 'ADMIN', status: 'APPROVED' },
    });
    if (!adminMember) throw new ForbiddenException('No tienes permisos para rechazar solicitudes');

    const memberToReject = await this.prisma.teamMember.findFirst({
      where: { userId, teamId: adminMember.teamId },
      include: { team: true },
    });
    if (!memberToReject) throw new NotFoundException('Solicitud no encontrada');

    const updatedUser = await this.prisma.user.update({
      where: { uuid: userId },
      data: { rejectionCount: { increment: 1 } },
    });

    const shouldBan = updatedUser.rejectionCount >= MAX_REJECTIONS;

    await this.prisma.teamMember.update({
      where: { id: memberToReject.id },
      data: { status: shouldBan ? 'BANNED' : 'REJECTED' },
    });

    if (shouldBan) {
      await this.prisma.user.update({ where: { uuid: userId }, data: { banned: true } });
    }

    // Notificar al usuario rechazado con los intentos restantes
    const attemptsLeft = Math.max(0, MAX_REJECTIONS - updatedUser.rejectionCount);
    await this.notificationsService.notifyMemberRejected(
      userId,
      memberToReject.team.id,
      memberToReject.team.name,
      attemptsLeft,
    );

    return {
      message: 'Solicitud rechazada',
      userRejectionCount: updatedUser.rejectionCount,
      banned: shouldBan,
    };
  }

  async getTeamProjects(teamId: string, callerId: string) {
    await this.teamScope.assertTeamAccess(callerId, teamId);
    const members = await this.prisma.teamMember.findMany({
      where: { teamId, status: MemberStatus.APPROVED },
      select: { userId: true },
    });
    const userIds = members.map((m) => m.userId);
    if (userIds.length === 0) return [];

    return this.prisma.project.findMany({
      where: { userProjectRoles: { some: { userId: { in: userIds } } } },
      select: { uuid: true, name: true, status: true, createdAt: true },
    });
  }

  async getTeamActivity(teamId: string, callerId: string) {
    await this.teamScope.assertTeamAccess(callerId, teamId);
    const members = await this.prisma.teamMember.findMany({
      where: { teamId, status: MemberStatus.APPROVED },
      select: { userId: true },
    });
    const userIds = members.map((m) => m.userId);
    if (userIds.length === 0) return [];

    const measurements = await this.prisma.measurement.findMany({
      where: { takenBy: { in: userIds } },
      orderBy: { takenAt: 'desc' },
      take: 50,
      include: {
        takenByUser: { select: { name: true } },
        task: { select: { name: true } },
      },
    });

    return measurements.map((m) => ({
      memberName: m.takenByUser?.name ?? null,
      taskName: m.task?.name ?? null,
      takenAt: m.takenAt,
      sensorDeviceName: m.sensorDeviceName,
      points: m.points,
      acquisition: parseAcquisitionSnapshot(m.acquisition),
    }));
  }

  async getMyTeam(userId: string) {
    const member = await this.prisma.teamMember.findFirst({
      where: { userId, status: MemberStatus.APPROVED },
      include: { team: true },
    });
    if (!member) throw new NotFoundException('No team found for this user');
    return member.team;
  }
}
