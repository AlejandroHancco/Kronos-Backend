import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';

/**
 * Identificadores LaaS de instancia (diseño §7.3): un sensor o actuator de un equipo registrado es
 * `<deviceId>:<sensorId|actuatorId del catálogo>`. Los ids de catálogo llevan '-', no ':'.
 */
export const toLaasId = (deviceId: string, catalogId: string): string => `${deviceId}:${catalogId}`;

/** Parte en el PRIMER ':'; 400 si el formato o el uuid no son válidos. */
export function parseLaasId(id: string): { deviceId: string; catalogId: string } {
  const sep = typeof id === 'string' ? id.indexOf(':') : -1;
  const deviceId = sep > 0 ? id.slice(0, sep) : '';
  const catalogId = sep > 0 ? id.slice(sep + 1) : '';
  if (!catalogId || !isUUID(deviceId)) throw new BadRequestException('Identificador LaaS inválido');
  return { deviceId, catalogId };
}
