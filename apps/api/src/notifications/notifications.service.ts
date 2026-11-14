import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { NotificationWriter } from '@app/notifications';

const MEASUREMENT_EVENT_TYPES = ['MEASUREMENT_COMPLETE', 'MEASUREMENT_WARNING', 'MEASUREMENT_FAILED'];

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private writer: NotificationWriter,
  ) {}

  // ── Escritura: delegada a NotificationWriter (@app/notifications) ───────────

  notifyMemberApproved(userId: string, teamId: string, teamName: string) {
    return this.writer.notifyMemberApproved(userId, teamId, teamName);
  }

  notifyMemberRejected(userId: string, teamId: string, teamName: string, attemptsLeft: number) {
    return this.writer.notifyMemberRejected(userId, teamId, teamName, attemptsLeft);
  }

  notifyAdminNewRequest(adminId: string, teamId: string, userName: string, teamName: string) {
    return this.writer.notifyAdminNewRequest(adminId, teamId, userName, teamName);
  }

  notifyTeamMeasurementSuccess(teamId: string, projectName: string, deviceNames: string[]) {
    return this.writer.notifyTeamMeasurementSuccess(teamId, projectName, deviceNames);
  }

  notifyTeamMeasurementWarning(teamId: string, projectName: string, deviceNames: string[], reason: string) {
    return this.writer.notifyTeamMeasurementWarning(teamId, projectName, deviceNames, reason);
  }

  notifyTeamMeasurementFailed(
    teamId: string,
    projectName: string,
    deviceNames: string[],
    errorMessage: string,
    bare = false,
  ) {
    return this.writer.notifyTeamMeasurementFailed(teamId, projectName, deviceNames, errorMessage, bare);
  }

  /**
   * Feed de actividad reciente del equipo (mediciones correctas/warning/fallidas).
   * Una fila = un evento real — ya no hace falta deduplicar nada.
   */
  async findRecentActivityForTeam(teamId: string, limit = 10) {
    return this.prisma.activityEvent.findMany({
      where: { teamId, type: { in: MEASUREMENT_EVENT_TYPES } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Log completo de actividad del equipo (todos los tipos de evento, paginado).
   * A diferencia de la bandeja personal, aquí no hay noción de "leído": es el
   * historial crudo de lo que pasó en el equipo.
   */
  async findActivityLogForTeam(
    teamId: string,
    options: { limit?: number; offset?: number; type?: string } = {},
  ) {
    const { limit = 20, offset = 0, type } = options;
    const where = { teamId, ...(type ? { type } : {}) };

    const [items, total] = await Promise.all([
      this.prisma.activityEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.activityEvent.count({ where }),
    ]);

    return { items, total };
  }

  // ── Bandeja personal (notificaciones) ───────────────────────────────────────

  async findForUser(userId: string) {
    const rows = await this.prisma.activityEventRecipient.findMany({
      where: { userId },
      include: { event: true },
      orderBy: { event: { createdAt: 'desc' } },
      take: 50,
    });

    return rows.map((r) => ({
      id: r.id,
      type: r.event.type,
      title: r.event.title,
      message: r.event.message,
      read: r.read,
      createdAt: r.event.createdAt,
      data: r.event.data,
    }));
  }

  async countUnread(userId: string) {
    const count = await this.prisma.activityEventRecipient.count({
      where: { userId, read: false },
    });
    return { unread: count };
  }

  async markAsRead(id: number, userId: string) {
    const recipient = await this.prisma.activityEventRecipient.findFirst({
      where: { id, userId },
    });
    if (!recipient) throw new NotFoundException('Notification not found');

    return this.prisma.activityEventRecipient.update({
      where: { id },
      data: { read: true },
    });
  }

  async markAllAsRead(userId: string) {
    await this.prisma.activityEventRecipient.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    return { message: 'Todas las notificaciones marcadas como leídas' };
  }
}
