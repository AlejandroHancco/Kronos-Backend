import { BadGatewayException, BadRequestException, ConflictException, GatewayTimeoutException } from '@nestjs/common';
import { HIOKI_IM3570, KRONOS_MUX_16, LaasCatalog, SIM_IMPEDANCE } from '@app/laas-catalog';
import RedisMock from 'ioredis-mock';
import { DeviceStateService, RedisLockService } from '@app/redis';
import { DeviceOpFailedError, DeviceOpTimeoutError } from '@app/queue';
import { DeviceConfigurationService } from './device-configuration.service';

const device = (type: string, over: Record<string, unknown> = {}) =>
  ({ id: `${type}-1`, name: type === 'kronos-mux-16' ? 'MUX' : 'Eq', type, ip: '10.0.0.4', status: 'online', projectId: 'P', configuration: null, ...over }) as any;

function setup() {
  const catalog = new LaasCatalog([HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE]);
  const update = jest.fn(async ({ where, data }) => ({ ...device('sim-impedance'), id: where.id, ...data }));
  const redis = new RedisMock() as any;
  const locks = new RedisLockService(redis);
  const state = new DeviceStateService(redis, locks, {
    scheduledJob: { findMany: jest.fn(async () => []) },
    taskPreference: { findMany: jest.fn(async () => []) },
  } as any);
  const ops = { request: jest.fn(async (): Promise<any> => ({})) };
  const service = new DeviceConfigurationService({ device: { update } } as any, catalog, state, ops as any);
  return { service, update, locks, ops };
}

const valueOf = (view: { parameters: Array<{ name: string; value: unknown }> }, name: string) =>
  view.parameters.find((p) => p.name === name)?.value;

const BUSY = '"MUX" está ocupado (midiendo o aplicando otra configuración); espera a que termine';

describe('DeviceConfigurationService', () => {
  beforeEach(async () => { await new RedisMock().flushall(); });
  it('view: valores por defecto y busy=false; sin parámetros live no encola nada', async () => {
    const { service, ops } = setup();
    const view = await service.view(device('sim-impedance'));
    expect(view).toMatchObject({ deviceId: 'sim-impedance-1', deviceType: 'sim-impedance', busy: false });
    expect(valueOf(view, 'rs')).toBe(150);
    expect(view.parameters.find((p) => p.name === 'rp')).toMatchObject({ label: 'Resistencia en paralelo (Rp)', storage: 'persisted', value: 20000 });
    expect(ops.request).not.toHaveBeenCalled();
  });

  it('view: lee los valores live vía read-live-configuration con DEVICE_OP_TIMEOUT_MS', async () => {
    const { service, ops } = setup();
    ops.request.mockResolvedValue({ channel: 5 });
    const view = await service.view(device('kronos-mux-16'));
    expect(ops.request).toHaveBeenCalledWith('read-live-configuration', { deviceId: 'kronos-mux-16-1' }, 25000);
    expect(valueOf(view, 'channel')).toBe(5);
    process.env.DEVICE_OP_TIMEOUT_MS = '2500';
    try {
      await service.view(device('kronos-mux-16'));
      expect(ops.request).toHaveBeenLastCalledWith('read-live-configuration', { deviceId: 'kronos-mux-16-1' }, 2500);
    } finally {
      delete process.env.DEVICE_OP_TIMEOUT_MS;
    }
  });

  it('view: worker sin respuesta o fallo → valor live null', async () => {
    const { service, ops } = setup();
    ops.request.mockRejectedValueOnce(new DeviceOpTimeoutError('timeout'));
    expect(valueOf(await service.view(device('kronos-mux-16')), 'channel')).toBeNull();
    ops.request.mockRejectedValueOnce(new DeviceOpFailedError('boom'));
    expect(valueOf(await service.view(device('kronos-mux-16')), 'channel')).toBeNull();
  });

  it('apply persistido: guarda en devices.configuration, no encola ninguna operación y devuelve la vista actualizada', async () => {
    const { service, update, ops } = setup();
    const view = await service.apply(device('sim-impedance', { configuration: { rs: 200, bogus: 1, rp: -5 } }), { rp: 40000 });
    expect(update).toHaveBeenCalledWith({ where: { id: 'sim-impedance-1' }, data: { configuration: { rs: 200, rp: 40000 } } });
    expect(valueOf(view, 'rp')).toBe(40000);
    expect(valueOf(view, 'rs')).toBe(200);
    expect(ops.request).not.toHaveBeenCalled();
  });

  it('apply persistido con el dispositivo ocupado → 409 (withExclusive) y no guarda', async () => {
    const { service, update, locks, ops } = setup();
    await locks.tryAcquire('lock:device:sim-impedance-1', 60_000);
    await expect(service.apply(device('sim-impedance'), { rp: 40000 })).rejects.toBeInstanceOf(ConflictException);
    expect(update).not.toHaveBeenCalled();
    expect(ops.request).not.toHaveBeenCalled();
  });

  it('apply: valores inválidos → 400 con el mensaje del parámetro', async () => {
    await expect(setup().service.apply(device('sim-impedance'), { rp: -1 })).rejects.toThrow(
      new BadRequestException('"Resistencia en paralelo (Rp)" debe estar entre 1 y 800000 Ω'),
    );
    await expect(setup().service.apply(device('sim-impedance'), { rp: -1, x: 1 })).rejects.toThrow(
      '"Resistencia en paralelo (Rp)" debe estar entre 1 y 800000 Ω; Parámetro de configuración desconocido: "x"',
    );
  });

  it('Hioki: solo lectura y regla entre campos', async () => {
    const { service, update, ops } = setup();
    await expect(service.apply(device('hioki-im3570'), { mode: 'X' })).rejects.toThrow('"Modo de medición" es de solo lectura');
    await expect(service.apply(device('hioki-im3570'), { defaultStartFreq: 600000 })).rejects.toThrow(
      new BadRequestException('"Frecuencia inicial por defecto" debe ser menor que "Frecuencia final por defecto"'),
    );
    expect(update).not.toHaveBeenCalled();
    expect(ops.request).not.toHaveBeenCalled();
  });

  it('MUX: el canal se aplica en vivo vía apply-live-configuration y no se guarda', async () => {
    const { service, update, ops } = setup();
    ops.request.mockImplementation((async (name: string) => (name === 'apply-live-configuration' ? undefined : {})) as any);
    const view = await service.apply(device('kronos-mux-16'), { channel: 3 });
    expect(ops.request).toHaveBeenCalledWith('apply-live-configuration', { deviceId: 'kronos-mux-16-1', values: { channel: 3 } }, 25000);
    expect(update).not.toHaveBeenCalled();
    expect(valueOf(view, 'channel')).toBeNull();
  });

  it('MUX midiendo → 409 y no se encola ninguna operación', async () => {
    const { service, locks, ops } = setup();
    await locks.tryAcquire('lock:device:kronos-mux-16-1', 60_000);
    await expect(service.apply(device('kronos-mux-16'), { channel: 3 })).rejects.toThrow(new ConflictException(BUSY));
    expect(ops.request).not.toHaveBeenCalled();
    expect((await service.view(device('kronos-mux-16'))).busy).toBe(true);
  });

  it('el worker rechaza con el 409 (carrera) → ConflictException', async () => {
    const { service, ops } = setup();
    ops.request.mockRejectedValue(new DeviceOpFailedError(BUSY));
    await expect(service.apply(device('kronos-mux-16'), { channel: 3 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('fallo del dispositivo → 502 con el mensaje actual', async () => {
    const { service, update, ops } = setup();
    ops.request.mockRejectedValue(new DeviceOpFailedError('No se pudo activar el canal 3 del MUX: ECONNREFUSED'));
    await expect(service.apply(device('kronos-mux-16'), { channel: 3 })).rejects.toThrow(
      new BadGatewayException('No se pudo aplicar la configuración en "MUX": No se pudo activar el canal 3 del MUX: ECONNREFUSED'),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('worker sin conexión → 504 y no se guarda nada', async () => {
    const { service, update, ops } = setup();
    ops.request.mockRejectedValue(new DeviceOpTimeoutError('timeout tras 10000ms'));
    await expect(service.apply(device('kronos-mux-16'), { channel: 3 })).rejects.toThrow(
      new GatewayTimeoutException('El laboratorio no respondió a tiempo'),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('dispositivo archivado → 400', async () => {
    await expect(setup().service.apply(device('sim-impedance', { status: 'archived' }), { rp: 40000 })).rejects.toThrow(
      new BadRequestException('No se puede configurar un dispositivo archivado'),
    );
  });

  it('valor live en un dispositivo sin IP → 400', async () => {
    const { service, ops } = setup();
    await expect(service.apply(device('kronos-mux-16', { ip: null }), { channel: 3 })).rejects.toThrow(
      new BadRequestException('"MUX" no tiene IP configurada'),
    );
    expect(ops.request).not.toHaveBeenCalled();
  });

  it('tipo sin plugin → 404', async () => {
    await expect(setup().service.view(device('analyzer'))).rejects.toThrow('No hay un device plugin registrado para el tipo "analyzer"');
  });
});
