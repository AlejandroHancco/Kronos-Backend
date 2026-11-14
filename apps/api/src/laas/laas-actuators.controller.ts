import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, RequirePermission } from '@app/common';
import { CombinedAuthGuard } from '../auth/combined-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import type { NormalizedUser } from '../auth/interfaces/auth.interface';
import { LaasInstancesService } from './laas-instances.service';
import { permissionOf } from './laas-operations';
import { SetActuatorDataDto } from './dto/set-actuator-data.dto';

@Controller('laas/v1/actuators')
@UseGuards(CombinedAuthGuard, PermissionGuard)
export class LaasActuatorsController {
  constructor(private readonly instances: LaasInstancesService) {}

  /** getActuatorMetadata (Tabla 19 por instancia). */
  @Get()
  @RequirePermission(permissionOf('getActuatorMetadata'))
  getActuatorMetadata(
    @Query('deviceId', new ParseUUIDPipe({ optional: true })) deviceId: string | undefined,
    @CurrentUser() user: NormalizedUser,
  ) {
    return this.instances.actuators(user.id, deviceId);
  }

  /** setActuatorData: 400 cuerpo/rango, 409 ocupado, 504 sin respuesta. */
  @Put(':actuatorId/data')
  @RequirePermission(permissionOf('setActuatorData'))
  setActuatorData(@Param('actuatorId') actuatorId: string, @Body() dto: SetActuatorDataDto, @CurrentUser() user: NormalizedUser) {
    return this.instances.setActuatorData(user.id, actuatorId, dto.values);
  }
}
