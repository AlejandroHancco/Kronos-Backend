import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '@app/common';
import { CombinedAuthGuard } from '../auth/combined-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import type { NormalizedUser } from '../auth/interfaces/auth.interface';
import { DevicesService } from '../devices/devices.service';
import { SetDeviceConfigurationDto } from '../devices/dto/set-device-configuration.dto';
import { permissionOf } from './laas-operations';

/**
 * getConfiguration / setConfiguration por dispositivo: mismos servicios que /devices/:id/configuration,
 * salvo que un dispositivo archivado responde 404 (como el resto de /laas/v1).
 */
@Controller('laas/v1/configuration')
@UseGuards(CombinedAuthGuard, PermissionGuard)
export class LaasConfigurationController {
  constructor(private readonly devices: DevicesService) {}

  @Get(':deviceId')
  @RequirePermission(permissionOf('getConfiguration'))
  getConfiguration(@Param('deviceId', ParseUUIDPipe) deviceId: string, @CurrentUser() user: NormalizedUser) {
    return this.devices.configurationForUser(deviceId, user.id, { excludeArchived: true });
  }

  @Put(':deviceId')
  @RequirePermission(permissionOf('setConfiguration'))
  setConfiguration(
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Body() dto: SetDeviceConfigurationDto,
    @CurrentUser() user: NormalizedUser,
  ) {
    return this.devices.configureForUser(deviceId, dto.values, user.id, { excludeArchived: true });
  }
}
