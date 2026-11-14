import { Controller, Get, UseGuards } from '@nestjs/common';
import { LaasCatalog } from '@app/laas-catalog';
import { CombinedAuthGuard } from '../auth/combined-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '@app/common';

@Controller('device-plugins')
@UseGuards(CombinedAuthGuard, PermissionGuard)
export class DevicePluginsController {
  constructor(private readonly laas: LaasCatalog) {}

  /** Catálogo de tipos de dispositivo: service descriptions descubribles (IEEE 1876 §4). */
  @Get()
  @RequirePermission('device:view')
  catalog() {
    return this.laas.catalog();
  }
}
