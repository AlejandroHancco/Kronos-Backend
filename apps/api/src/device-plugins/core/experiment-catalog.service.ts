import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/database';
import { TeamScopeService } from '@app/common';
import { ExperimentDefinition, LaasCatalog, experimentCatalog } from '@app/laas-catalog';

export interface ExperimentDeviceOption { id: string; name: string; ip: string | null; status: string }

/** Experimento con los dispositivos del proyecto que pueden ocupar cada lugar. */
export interface ProjectExperiment extends ExperimentDefinition {
  sensorDevices: ExperimentDeviceOption[];
  channelSelectorDevices: ExperimentDeviceOption[];
  available: boolean;
  unavailableReason?: string;
}

@Injectable()
export class ExperimentCatalogService {
  constructor(
    private prisma: PrismaService,
    private laas: LaasCatalog,
    private teamScope: TeamScopeService,
  ) {}

  catalog(): ExperimentDefinition[] {
    return experimentCatalog(this.laas.catalog());
  }

  async forProject(projectId: string, userId: string): Promise<ProjectExperiment[]> {
    await this.teamScope.assertProjectInTeam(userId, projectId);
    const devices = await this.prisma.device.findMany({
      where: { projectId, status: { not: 'archived' } },
      select: { id: true, name: true, type: true, ip: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    const ofType = (type: string | null): ExperimentDeviceOption[] =>
      type ? devices.filter((d) => d.type === type).map(({ id, name, ip, status }) => ({ id, name, ip, status })) : [];
    const shortName = (type: string) => this.laas.describe(type).shortName;

    return this.catalog().map((e) => {
      const sensorDevices = ofType(e.sensorType);
      const channelSelectorDevices = ofType(e.channelSelectorType);
      const missing = sensorDevices.length === 0
        ? e.sensorType
        : e.channelSelectorType && channelSelectorDevices.length === 0 ? e.channelSelectorType : null;
      return {
        ...e,
        sensorDevices,
        channelSelectorDevices,
        available: !missing,
        ...(missing ? { unavailableReason: `No hay un dispositivo "${shortName(missing)}" en el proyecto` } : {}),
      };
    });
  }
}
