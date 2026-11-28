import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { RealtimePublisher } from '@app/realtime';

/** "<equipo> se desconectó a las HH:MM. N mediciones programadas en la próxima hora." (campana y correo) */
export function deviceOfflineMessage(deviceName: string, hhmm: string, atRisk: number): string {
  const scheduled = atRisk === 1 ? '1 medición programada' : `${atRisk} mediciones programadas`;
  return `${deviceName} se desconectó a las ${hhmm}. ${scheduled} en la próxima hora.`;
}

/** "<equipo> volvió a estar disponible (desconectado X min). Puntos perdidos: M." */
export function deviceOnlineMessage(deviceName: string, downMinutes: number, lostPoints: number): string {
  return `${deviceName} volvió a estar disponible (desconectado ${downMinutes} min). Puntos perdidos: ${lostPoints}.`;
}

@Injectable()
export class NotificationWriter {
  constructor(
    private prisma: PrismaService,
    private realtime: RealtimePublisher,
  ) {}

  /**
   * Registra un ActivityEvent (siempre — es el log del equipo) y, si se indican
   * destinatarios, crea su fila de bandeja personal y les emite por WebSocket.
   * No todo evento notifica a alguien: eso lo decide cada método de arriba.
   */
  private async logEvent(params: {
    teamId: string;
    type: string;
    title: string;
    message: string;
    createdAt?: Date;
    notifyUserIds?: string[];
  }) {
    const event = await this.prisma.activityEvent.create({
      data: {
        teamId: params.teamId,
        type: params.type,
        title: params.title,
        message: params.message,
        createdAt: params.createdAt,
      },
    });

    const notifyUserIds = params.notifyUserIds ?? [];
    if (notifyUserIds.length > 0) {
      await this.prisma.activityEventRecipient.createMany({
        data: notifyUserIds.map((userId) => ({ eventId: event.id, userId })),
        skipDuplicates: true,
      });
      for (const userId of notifyUserIds) {
        this.realtime.notification(userId, {
          id: event.id,
          type: event.type,
          title: event.title,
          message: event.message,
          read: false,
          createdAt: event.createdAt,
        });
      }
    }

    return event;
  }

  // ── Membresía de equipo (personal, un solo destinatario) ───────────────────

  async notifyMemberApproved(userId: string, teamId: string, teamName: string) {
    await this.logEvent({
      teamId,
      type: 'TEAM_APPROVED',
      title: 'Solicitud aprobada',
      message: `Has sido aprobado en ${teamName}`,
      notifyUserIds: [userId],
    });
  }

  async notifyMemberRejected(userId: string, teamId: string, teamName: string, attemptsLeft: number) {
    await this.logEvent({
      teamId,
      type: 'TEAM_REJECTED',
      title: 'Solicitud rechazada',
      message: `Tu solicitud en ${teamName} fue rechazada. Te quedan ${attemptsLeft} intentos.`,
      notifyUserIds: [userId],
    });
  }

  async notifyAdminNewRequest(adminId: string, teamId: string, userName: string, teamName: string) {
    await this.logEvent({
      teamId,
      type: 'TEAM_JOIN_REQUEST',
      title: 'Nueva solicitud',
      message: `${userName} quiere unirse a ${teamName}`,
      notifyUserIds: [adminId],
    });
  }

  // ── Alertas de mediciones ("Kronos Watcher") — log de equipo + notifica a todos ──

  private async getApprovedTeamMemberIds(teamId: string): Promise<string[]> {
    const members = await this.prisma.teamMember.findMany({
      where: { teamId, status: 'APPROVED' },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  async notifyTeamMeasurementSuccess(
    teamId: string,
    projectName: string,
    deviceNames: string[],
  ) {
    let message = `Medición correcta en "${projectName}"`;
    if (deviceNames.length > 0) {
      message += `\n${deviceNames.join(', ')}`;
    }

    const memberIds = await this.getApprovedTeamMemberIds(teamId);
    await this.logEvent({
      teamId,
      type: 'MEASUREMENT_COMPLETE',
      title: 'Medición correcta',
      message,
      notifyUserIds: memberIds,
    });
  }

  async notifyTeamMeasurementWarning(
    teamId: string,
    projectName: string,
    deviceNames: string[],
    reason: string,
  ) {
    let message = `Advertencia al medir en "${projectName}": ${reason}`;
    if (deviceNames.length > 0) {
      message += `\n${deviceNames.join(', ')}`;
    }

    const memberIds = await this.getApprovedTeamMemberIds(teamId);
    await this.logEvent({
      teamId,
      type: 'MEASUREMENT_WARNING',
      title: 'Advertencia en medición',
      message,
      notifyUserIds: memberIds,
    });
  }

  async notifyTeamMeasurementFailed(
    teamId: string,
    projectName: string,
    deviceNames: string[],
    errorMessage: string,
    /** true: usa `errorMessage` tal cual, sin prefijo ni dispositivos (ej. "No se recibieron datos de medición"). */
    bare = false,
  ) {
    let message = bare ? errorMessage : `Ocurrió un error al medir en "${projectName}": ${errorMessage}`;
    if (!bare && deviceNames.length > 0) {
      message += `\n${deviceNames.join(', ')}`;
    }

    const memberIds = await this.getApprovedTeamMemberIds(teamId);
    await this.logEvent({
      teamId,
      type: 'MEASUREMENT_FAILED',
      title: 'Error al medir',
      message,
      notifyUserIds: memberIds,
    });
  }

  // ── Conexión de dispositivos (worker, health check) — destinatarios los decide quien llama ──

  /** Un evento DEVICE_OFFLINE en el log de `teamId`, con campana para `userIds`. `hhmm`: hora local de la caída. */
  async notifyDeviceOffline(
    teamId: string,
    userIds: string[],
    device: { id: string; name: string },
    atRisk: number,
    hhmm: string,
  ) {
    await this.logEvent({
      teamId,
      type: 'DEVICE_OFFLINE',
      title: 'Equipo desconectado',
      message: deviceOfflineMessage(device.name, hhmm, atRisk),
      notifyUserIds: userIds,
    });
  }

  /** Un evento DEVICE_ONLINE en el log de `teamId`, con campana para `userIds`. */
  async notifyDeviceOnline(
    teamId: string,
    userIds: string[],
    device: { id: string; name: string },
    downMinutes: number,
    lostPoints: number,
  ) {
    await this.logEvent({
      teamId,
      type: 'DEVICE_ONLINE',
      title: 'Equipo disponible',
      message: deviceOnlineMessage(device.name, downMinutes, lostPoints),
      notifyUserIds: userIds,
    });
  }
}
