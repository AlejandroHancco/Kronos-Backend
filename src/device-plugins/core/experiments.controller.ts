import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CombinedAuthGuard } from '../../auth/combined-auth.guard';
import { PermissionGuard } from '../../auth/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { NormalizedUser } from '../../auth/interfaces/auth.interface';
import { ExperimentCatalogService } from './experiment-catalog.service';

@Controller('experiments')
@UseGuards(CombinedAuthGuard, PermissionGuard)
export class ExperimentsController {
  constructor(private readonly experiments: ExperimentCatalogService) {}

  /** IEEE 1876 getExperiment (nuestra lectura de la Tabla 20): experimentos derivados de los plugins. */
  @Get()
  @RequirePermission('device:view')
  catalog() {
    return this.experiments.catalog();
  }
}

@Controller('projects/:projectId/experiments')
@UseGuards(CombinedAuthGuard, PermissionGuard)
export class ProjectExperimentsController {
  constructor(private readonly experiments: ExperimentCatalogService) {}

  /** Experimentos con los dispositivos del proyecto que pueden usarse en cada uno. */
  @Get()
  @RequirePermission('device:view')
  forProject(@Param('projectId') projectId: string, @CurrentUser() user: NormalizedUser) {
    return this.experiments.forProject(projectId, user.id);
  }
}
