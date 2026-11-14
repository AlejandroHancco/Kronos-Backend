import { Controller, Get, UseGuards } from '@nestjs/common';
import { DevicePluginRegistry } from './core/device-plugin.registry';
import { CombinedAuthGuard } from '../auth/combined-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

@Controller('device-plugins')
@UseGuards(CombinedAuthGuard, PermissionGuard)
export class DevicePluginsController {
  constructor(private readonly registry: DevicePluginRegistry) {}

  /** Catálogo de tipos de dispositivo: service descriptions descubribles (IEEE 1876 §4). */
  @Get()
  @RequirePermission('device:view')
  catalog() {
    return this.registry.catalog();
  }
}
