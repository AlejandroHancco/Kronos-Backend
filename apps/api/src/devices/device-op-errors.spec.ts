import { BadGatewayException, BadRequestException, ConflictException, GatewayTimeoutException } from '@nestjs/common';
import { DeviceOpFailedError, DeviceOpTimeoutError } from '@app/queue';
import { deviceBusyMessage } from '@app/redis';
import { mapDeviceOpError } from './device-op-errors';

describe('mapDeviceOpError', () => {
  it('timeout → 504', () => {
    const e = mapDeviceOpError(new DeviceOpTimeoutError('timeout'), 'MUX');
    expect(e).toBeInstanceOf(GatewayTimeoutException);
    expect(e.message).toBe('El laboratorio no respondió a tiempo');
  });

  it('dispositivo midiendo → 409 con el mensaje del worker', () => {
    const e = mapDeviceOpError(new DeviceOpFailedError(`ConflictException: ${deviceBusyMessage('MUX')}`), 'MUX');
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.message).toBe(deviceBusyMessage('MUX'));
  });

  it('valor de actuator rechazado por el worker (rango/paso) → 400 con su mensaje', () => {
    const e = mapDeviceOpError(new DeviceOpFailedError('"channel" debe estar entre 1 y 16'), 'MUX');
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.message).toBe('"channel" debe estar entre 1 y 16');
    expect(mapDeviceOpError(new DeviceOpFailedError('BadRequestException: "channel" debe avanzar en pasos de 1 desde 1'), 'MUX'))
      .toBeInstanceOf(BadRequestException);
  });

  it('otro fallo → 502 (con el objeto de la operación)', () => {
    expect(mapDeviceOpError(new DeviceOpFailedError('ECONNREFUSED'), 'MUX').message)
      .toBe('No se pudo aplicar la configuración en "MUX": ECONNREFUSED');
    const e = mapDeviceOpError(new DeviceOpFailedError('ECONNREFUSED'), 'MUX', 'el valor del actuador');
    expect(e).toBeInstanceOf(BadGatewayException);
    expect(e.message).toBe('No se pudo aplicar el valor del actuador en "MUX": ECONNREFUSED');
  });
});
