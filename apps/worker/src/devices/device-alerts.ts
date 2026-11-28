import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { NotificationWriter, deviceOfflineMessage } from '@app/notifications';
import { MailOutbox } from '@app/queue';
import { SeriesReservationsService, limaTime } from '@app/measurement';

export interface AlertDevice {
  id: string;
  name: string;
  projectId: string;
}

/** Ventana (min) de "mediciones programadas en la próxima hora" del aviso de desconexión. */
const AT_RISK_MINUTES = 60;

interface TeamRecipients {
  teamId: string;
  userIds: string[];
}

/**
 * Avisos de desconexión y recuperación de un dispositivo. Destinatarios: los equipos del proyecto
 * del dispositivo (TeamScopeService.teamIdsForProject); campana a sus miembros APPROVED (un evento
 * por equipo; cada usuario una sola vez) y, al desconectarse, correo a sus ADMIN APPROVED
 * (vía MailOutbox: el worker no tiene internet, la API lo envía). Un fallo con un equipo o un
 * correo se registra y no impide los demás.
 */
@Injectable()
export class DeviceAlerts {
  private readonly logger = new Logger(DeviceAlerts.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly teamScope: TeamScopeService,
    private readonly writer: NotificationWriter,
    private readonly outbox: MailOutbox,
    private readonly reservations: SeriesReservationsService,
  ) {}

  async deviceOffline(device: AlertDevice, at: Date): Promise<void> {
    const { teams, adminEmails } = await this.recipients(device.projectId);
    if (teams.length === 0) return;
    const atRisk = await this.reservations.upcomingForDevice(
      device.id,
      device.projectId,
      at,
      AT_RISK_MINUTES,
    );
    const hhmm = limaTime(at);
    const ref = { id: device.id, name: device.name };

    for (const t of teams) {
      await this.attempt(
        `campana de desconexión de ${device.id} (equipo ${t.teamId})`,
        () =>
          this.writer.notifyDeviceOffline(
            t.teamId,
            t.userIds,
            ref,
            atRisk,
            hhmm,
          ),
      );
    }
    const subject = `KRONOS: ${device.name} desconectado`;
    const text = deviceOfflineMessage(device.name, hhmm, atRisk);
    for (const to of adminEmails) {
      await this.attempt(`correo de desconexión de ${device.id} a ${to}`, () =>
        this.outbox.enqueue({ to, subject, text }),
      );
    }
  }

  /** `from`: inicio de la caída; `to`: momento de la recuperación. */
  async deviceOnline(device: AlertDevice, from: Date, to: Date): Promise<void> {
    const { teams } = await this.recipients(device.projectId);
    if (teams.length === 0) return;
    const downMinutes = Math.max(
      0,
      Math.round((to.getTime() - from.getTime()) / 60_000),
    );
    const lostPoints = await this.reservations.missedOfflineForDevice(
      device.id,
      device.projectId,
      from,
      to,
    );
    const ref = { id: device.id, name: device.name };

    for (const t of teams) {
      await this.attempt(
        `aviso de recuperación de ${device.id} (equipo ${t.teamId})`,
        () =>
          this.writer.notifyDeviceOnline(
            t.teamId,
            t.userIds,
            ref,
            downMinutes,
            lostPoints,
          ),
      );
    }
  }

  private async recipients(
    projectId: string,
  ): Promise<{ teams: TeamRecipients[]; adminEmails: string[] }> {
    const teamIds = await this.teamScope.teamIdsForProject(projectId);
    if (teamIds.length === 0) return { teams: [], adminEmails: [] };
    const members = await this.prisma.teamMember.findMany({
      where: { teamId: { in: teamIds }, status: 'APPROVED' },
      select: {
        teamId: true,
        userId: true,
        role: true,
        user: { select: { email: true } },
      },
    });

    const seenUsers = new Set<string>();
    // todo equipo relacionado registra el evento en su log, aunque sus miembros ya tengan la campana por otro
    const byTeam = new Map<string, string[]>(teamIds.map((id) => [id, []]));
    const adminEmails = new Set<string>();
    for (const m of members) {
      if (m.role === 'ADMIN' && m.user.email) adminEmails.add(m.user.email);
      if (seenUsers.has(m.userId)) continue;
      seenUsers.add(m.userId);
      byTeam.get(m.teamId)?.push(m.userId);
    }
    return {
      teams: [...byTeam].map(([teamId, userIds]) => ({ teamId, userIds })),
      adminEmails: [...adminEmails],
    };
  }

  private async attempt(
    what: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error(
        `No se pudo enviar ${what}`,
        err instanceof Error ? err.stack : err,
      );
    }
  }
}
