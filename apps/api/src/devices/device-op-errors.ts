import { BadGatewayException, BadRequestException, ConflictException, GatewayTimeoutException } from '@nestjs/common';
import { DeviceOpFailedError, DeviceOpTimeoutError } from '@app/queue';
import { isActuatorValueError } from '@app/laas-catalog';
// Marca del 409 de DeviceStateService.withExclusive (el worker lo lanza al ejecutar una operación live).
import { DEVICE_BUSY_MARKER } from '@app/redis';

/** Timeouts de las operaciones de dispositivo (se leen en cada llamada). */
export const deviceTestTimeoutMs = (): number => Number(process.env.DEVICE_TEST_TIMEOUT_MS) || 5000;
export const deviceOpTimeoutMs = (): number => Number(process.env.DEVICE_OP_TIMEOUT_MS) || 10000;

/**
 * Convierte un error de DeviceOpsClient en la excepción HTTP equivalente:
 * sin respuesta → 504, 409 del worker (dispositivo midiendo) → 409, valor de actuator rechazado
 * por el worker (rango/paso, ver actuatorValuesError) → 400, otro fallo → 502.
 */
export function mapDeviceOpError(err: unknown, deviceName: string, what = 'la configuración'): Error {
  if (err instanceof DeviceOpTimeoutError) return new GatewayTimeoutException('El laboratorio no respondió a tiempo');
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof DeviceOpFailedError) {
    const reason = msg.replace(/^(\w*Exception|Error):\s*/, '');
    if (msg.includes(DEVICE_BUSY_MARKER)) return new ConflictException(reason);
    if (isActuatorValueError(reason)) return new BadRequestException(reason);
  }
  return new BadGatewayException(`No se pudo aplicar ${what} en "${deviceName}": ${msg}`);
}
