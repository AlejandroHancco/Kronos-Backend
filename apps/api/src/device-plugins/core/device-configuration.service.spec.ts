import { BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common';
import axios from 'axios';
import { HIOKI_IM3570, KRONOS_MUX_16, LaasCatalog, SIM_IMPEDANCE } from '@app/laas-catalog';
import { DeviceDriverRegistry, HiokiIm3570Driver, KronosMux16Driver, SimulatedImpedanceDriver } from '@app/device-drivers';
import RedisMock from 'ioredis-mock';
import { DeviceStateService, RedisLockService } from '@app/redis';
import { DeviceConfigurationService } from './device-configuration.service';

jest.mock('axios');
const mockedGet = axios.get as jest.Mock;

const device = (type: string, over: Record<string, unknown> = {}) =>
  ({ id: `${type}-1`, name: type === 'kronos-mux-16' ? 'MUX' : 'Eq', type, ip: '10.0.0.4', status: 'online', projectId: 'P', configuration: null, ...over }) as any;

function setup() {
  const mux = new KronosMux16Driver();
  mux.retryDelayMs = 0;
  const catalog = new LaasCatalog([HIOKI_IM3570, KRONOS_MUX_16, SIM_IMPEDANCE]);
  const drivers = new DeviceDriverRegistry([new HiokiIm3570Driver(), mux, new SimulatedImpedanceDriver()]);
  const update = jest.fn(async ({ where, data }) => ({ ...device('sim-impedance'), id: where.id, ...data }));
  const redis = new RedisMock() as any;
  const locks = new RedisLockService(redis);
  const state = new DeviceStateService(redis, locks, {
    scheduledJob: { findMany: jest.fn(async () => []) },
    taskPreference: { findMany: jest.fn(async () => []) },
  } as any);
  const service = new DeviceConfigurationService({ device: { update } } as any, catalog, drivers, state);
  return { service, update, locks };
}

const valueOf = (view: { parameters: Array<{ name: string; value: unknown }> }, name: string) =>
  view.parameters.find((p) => p.name === name)?.value;

beforeEach(() => mockedGet.mockReset());

describe('DeviceConfigurationService', () => {
  it('view: valores por defecto y busy=false', async () => {
    const view = await setup().service.view(device('sim-impedance'));
    expect(view).toMatchObject({ deviceId: 'sim-impedance-1', deviceType: 'sim-impedance', busy: false });
    expect(valueOf(view, 'rs')).toBe(150);
    expect(view.parameters.find((p) => p.name === 'rp')).toMatchObject({ label: 'Resistencia en paralelo (Rp)', storage: 'persisted', value: 20000 });
  });

  it('apply persistido: guarda en devices.configuration y devuelve la vista actualizada', async () => {
    const { service, update } = setup();
    const view = await service.apply(device('sim-impedance', { configuration: { rs: 200, bogus: 1, rp: -5 } }), { rp: 40000 });
    expect(update).toHaveBeenCalledWith({ where: { id: 'sim-impedance-1' }, data: { configuration: { rs: 200, rp: 40000 } } });
    expect(valueOf(view, 'rp')).toBe(40000);
    expect(valueOf(view, 'rs')).toBe(200);
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
    const { service, update } = setup();
    await expect(service.apply(device('hioki-im3570'), { mode: 'X' })).rejects.toThrow('"Modo de medición" es de solo lectura');
    await expect(service.apply(device('hioki-im3570'), { defaultStartFreq: 600000 })).rejects.toThrow(
      new BadRequestException('"Frecuencia inicial por defecto" debe ser menor que "Frecuencia final por defecto"'),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('MUX: el canal se aplica en vivo y no se guarda (el driver no lo recuerda)', async () => {
    mockedGet.mockResolvedValue({ status: 200 });
    const { service, update } = setup();
    const view = await service.apply(device('kronos-mux-16'), { channel: 3 });
    expect(mockedGet).toHaveBeenCalledWith('http://10.0.0.4/?orden=3', expect.anything());
    expect(update).not.toHaveBeenCalled();
    // Driver sin estado: hasta que el core registre los valores live, el canal activo es desconocido.
    expect(valueOf(view, 'channel')).toBeNull();
  });

  it('MUX sin canal conocido: null', async () => {
    expect(valueOf(await setup().service.view(device('kronos-mux-16')), 'channel')).toBeNull();
  });

  it('MUX midiendo → 409; fallo del dispositivo → 502', async () => {
    const { service, locks } = setup();
    const token = await locks.tryAcquire('lock:device:kronos-mux-16-1', 60_000);
    await expect(service.apply(device('kronos-mux-16'), { channel: 3 })).rejects.toBeInstanceOf(ConflictException);
    expect((await service.view(device('kronos-mux-16'))).busy).toBe(true);
    await locks.release('lock:device:kronos-mux-16-1', token!);
    mockedGet.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.apply(device('kronos-mux-16'), { channel: 3 })).rejects.toThrow(
      new BadGatewayException('No se pudo aplicar la configuración en "MUX": No se pudo activar el canal 3 del MUX: ECONNREFUSED'),
    );
  });

  it('dispositivo archivado → 400', async () => {
    await expect(setup().service.apply(device('sim-impedance', { status: 'archived' }), { rp: 40000 })).rejects.toThrow(
      new BadRequestException('No se puede configurar un dispositivo archivado'),
    );
  });

  it('valor live en un dispositivo sin IP → 400', async () => {
    await expect(setup().service.apply(device('kronos-mux-16', { ip: null }), { channel: 3 })).rejects.toThrow(
      new BadRequestException('"MUX" no tiene IP configurada'),
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('tipo sin plugin → 404', async () => {
    await expect(setup().service.view(device('analyzer'))).rejects.toThrow('No hay un device plugin registrado para el tipo "analyzer"');
  });
});
