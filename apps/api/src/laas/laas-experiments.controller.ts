import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '@app/common';
import { LaasCatalog } from '@app/laas-catalog';
import { CombinedAuthGuard } from '../auth/combined-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import type { NormalizedUser } from '../auth/interfaces/auth.interface';
import { ExperimentCatalogService } from '../device-plugins/core/experiment-catalog.service';
import { permissionOf } from './laas-operations';
import { LaasExperiment, publishExperiment } from './laas-publish';

/** getExperiment (Tabla 20): del catálogo, o con las instancias de un proyecto. */
@Controller('laas/v1/experiments')
@UseGuards(CombinedAuthGuard, PermissionGuard)
export class LaasExperimentsController {
  constructor(
    private readonly experiments: ExperimentCatalogService,
    private readonly catalog: LaasCatalog,
  ) {}

  @Get()
  @RequirePermission(permissionOf('getExperiment'))
  async getExperiment(
    @Query('projectId', new ParseUUIDPipe({ optional: true })) projectId: string | undefined,
    @CurrentUser() user: NormalizedUser,
  ): Promise<LaasExperiment[]> {
    const describe = (type: string) => this.catalog.describe(type);
    if (!projectId) return this.experiments.catalog().map((e) => publishExperiment(e, describe));
    const forProject = await this.experiments.forProject(projectId, user.id);
    return forProject.map((e) =>
      publishExperiment(e, describe, {
        sensorDeviceIds: e.sensorDevices.map((d) => d.id),
        channelSelectorDeviceIds: e.channelSelectorDevices.map((d) => d.id),
        available: e.available,
      }),
    );
  }
}
