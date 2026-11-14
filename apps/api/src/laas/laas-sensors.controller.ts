import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, RequirePermission } from '@app/common';
import { CombinedAuthGuard } from '../auth/combined-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import type { NormalizedUser } from '../auth/interfaces/auth.interface';
import { PermissionsService } from '../permissions/permissions.service';
import { LaasInstancesService } from './laas-instances.service';
import { FRESH_SENSOR_DATA_PERMISSION, permissionOf } from './laas-operations';

/** `1,2` → [1, 2]; vacío → undefined; 400 si no son enteros positivos. */
export function parseChannels(raw: string | undefined): number[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parts = raw.split(',').map((p) => p.trim());
  if (!parts.every((p) => /^[1-9]\d*$/.test(p))) {
    throw new BadRequestException('channels debe ser una lista de canales separados por comas (p. ej. 1,2)');
  }
  return [...new Set(parts.map(Number))];
}

@Controller('laas/v1/sensors')
@UseGuards(CombinedAuthGuard, PermissionGuard)
export class LaasSensorsController {
  constructor(
    private readonly instances: LaasInstancesService,
    private readonly permissions: PermissionsService,
  ) {}

  /** getSensorMetadata (Tabla 14 por instancia). */
  @Get()
  @RequirePermission(permissionOf('getSensorMetadata'))
  getSensorMetadata(
    @Query('deviceId', new ParseUUIDPipe({ optional: true })) deviceId: string | undefined,
    @CurrentUser() user: NormalizedUser,
  ) {
    return this.instances.sensors(user.id, deviceId);
  }

  /** getSensorData: última lectura; con fresh=true encola una medición y responde 202. */
  @Get(':sensorId/data')
  @RequirePermission(permissionOf('getSensorData'))
  async getSensorData(
    @Param('sensorId') sensorId: string,
    @Query('taskId', new ParseIntPipe({ optional: true })) taskId: number | undefined,
    @Query('fresh') fresh: string | undefined,
    @Query('channels') channels: string | undefined,
    @CurrentUser() user: NormalizedUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (fresh !== 'true') return this.instances.sensorData(user.id, sensorId, taskId);
    if (!(await this.permissions.hasPermission(user.id, FRESH_SENSOR_DATA_PERMISSION))) {
      throw new ForbiddenException(`Missing permission: ${FRESH_SENSOR_DATA_PERMISSION}`);
    }
    const job = await this.instances.requestFresh(user.id, sensorId, taskId, parseChannels(channels));
    res.status(HttpStatus.ACCEPTED);
    return job;
  }
}
