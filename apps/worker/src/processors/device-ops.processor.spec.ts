import { EventEmitter } from 'events';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Job } from 'bull';
// Clase Job real de Bull: fija failedReason a partir del error lanzado por el processor.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BullJob = require('bull/lib/job');
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { HIOKI_IM3570, KRONOS_MUX_16, LaasCatalog, SIM_IMPEDANCE } from '@app/laas-catalog';
import { DeviceStateService, LiveValueStore, RedisLockService, deviceBusyMessage } from '@app/redis';
import { DeviceOpsClient } from '@app/queue';
// Solo en el spec: el contrato con la API (mapDeviceOpError) se comprueba de punta a punta.
import { mapDeviceOpError } from '../../../api/src/devices/device-op-errors';
import { DeviceReachability } from '../devices/device-reachability';
import { DeviceOpsProcessor } from './device-ops.processor';

const devices: Record<string, any> = {
  mux1: { id: 'mux1', name: 'MUX', type: 'kronos-mux-16', ip: '10.0.0.2', status: 'online', configuration: null },
  hio1: { id: 'hio1', name: 'Hioki', type: 'hioki-im3570', ip: '10.0.0.3', status: 'online', configuration: null },
  sim1: { id: 'sim1', name: 'Sim', type: 'sim-impedance', ip: null, status: 'online', configuration: null },
};

function job<T>(name: string, data: T): Job<T> {
  return { id: '1', name, data } as unknown as Job<T>;
}

let redis: Redis;

function setup(kronos: typeof KRONOS_MUX_16 = KRONOS_MUX_16) {
  const catalog = new LaasCatalog([HIOKI_IM3570, kronos, SIM_IMPEDANCE]);
  const muxDriver = {
    deviceType: 'kronos-mux-16',
    testConnection: jest.fn(async () => true),
    setActuatorData: jest.fn(async () => undefined),
    applyLiveConfiguration: jest.fn(async () => undefined),
  };
  const hiokiDriver: any = {
    deviceType: 'hioki-im3570',
    testConnection: jest.fn(async () => true),
    applyLiveConfiguration: jest.fn(async () => undefined),
  };
  const simDriver = { deviceType: 'sim-impedance', testConnection: jest.fn(async () => true) };
  const byType: Record<string, any> = { 'kronos-mux-16': muxDriver, 'hioki-im3570': hiokiDriver, 'sim-impedance': simDriver };
  const drivers = {
    has: (t: string) => !!byType[t],
    get: (t: string) => byType[t],
    actuator: (t: string) => byType[t],
  };
  const prisma = { device: { findUnique: jest.fn(async ({ where }: any) => devices[where.id] ?? null) } };
  const locks = new RedisLockService(redis);
  const deviceState = new DeviceStateService(redis, locks, {} as any);
  const liveValues = new LiveValueStore(redis);
  const reachability = new DeviceReachability(catalog, drivers as any);
  const processor = new DeviceOpsProcessor(prisma as any, catalog, drivers as any, deviceState, liveValues, reachability);
  return { processor, muxDriver, hiokiDriver, simDriver, liveValues, locks, catalog };
}

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
});
afterEach(() => redis.disconnect());

describe('DeviceOpsProcessor: test-connection', () => {
  it('normaliza el payload de la API: ip "" → null y port 0 → defaultPort del catálogo', async () => {
    const { processor, simDriver, hiokiDriver } = setup();
    expect(await processor.handle(job('test-connection', { type: 'sim-impedance', ip: '', port: 0 }))).toBe(true);
    expect(simDriver.testConnection).toHaveBeenCalledWith({ ip: null, port: undefined });

    await processor.handle(job('test-connection', { type: 'hioki-im3570', ip: '10.0.0.3', port: 0 }));
    expect(hiokiDriver.testConnection).toHaveBeenLastCalledWith({ ip: '10.0.0.3', port: HIOKI_IM3570.description.connection.defaultPort });

    await processor.handle(job('test-connection', { type: 'hioki-im3570', ip: '10.0.0.3' } as any));
    expect(hiokiDriver.testConnection).toHaveBeenLastCalledWith({ ip: '10.0.0.3', port: HIOKI_IM3570.description.connection.defaultPort });

    await processor.handle(job('test-connection', { type: 'hioki-im3570', ip: '10.0.0.3', port: 4000 }));
    expect(hiokiDriver.testConnection).toHaveBeenLastCalledWith({ ip: '10.0.0.3', port: 4000 });
  });

  it('tipo desconocido → false', async () => {
    const { processor } = setup();
    expect(await processor.handle(job('test-connection', { type: 'toaster', ip: '1.2.3.4', port: 1 }))).toBe(false);
  });
});

describe('DeviceOpsProcessor: read-live-configuration', () => {
  it('sin readLiveConfiguration en el driver: valor de LiveValueStore, o null', async () => {
    const { processor, liveValues } = setup();
    expect(await processor.handle(job('read-live-configuration', { deviceId: 'mux1' }))).toEqual({ channel: null });
    await liveValues.record('mux1', { channel: 7 });
    expect(await processor.handle(job('read-live-configuration', { deviceId: 'mux1' }))).toEqual({ channel: 7 });
  });

  it('con readLiveConfiguration: usa el valor del equipo y cae al ledger cuando es null', async () => {
    const { processor, muxDriver, liveValues } = setup();
    const read = jest.fn(async (): Promise<Record<string, number | null>> => ({ channel: 3 }));
    (muxDriver as any).readLiveConfiguration = read;
    await liveValues.record('mux1', { channel: 7 });
    expect(await processor.handle(job('read-live-configuration', { deviceId: 'mux1' }))).toEqual({ channel: 3 });
    expect(read).toHaveBeenCalledWith({ id: 'mux1', name: 'MUX', ip: '10.0.0.2', configuration: {} });
    read.mockResolvedValue({ channel: null });
    expect(await processor.handle(job('read-live-configuration', { deviceId: 'mux1' }))).toEqual({ channel: 7 });
  });

  it('si readLiveConfiguration falla, responde con el ledger', async () => {
    const { processor, muxDriver, liveValues } = setup();
    (muxDriver as any).readLiveConfiguration = jest.fn(async () => {
      throw new Error('timeout');
    });
    await liveValues.record('mux1', { channel: 9 });
    expect(await processor.handle(job('read-live-configuration', { deviceId: 'mux1' }))).toEqual({ channel: 9 });
  });

  it('sin parámetros live → objeto vacío', async () => {
    const { processor } = setup();
    expect(await processor.handle(job('read-live-configuration', { deviceId: 'hio1' }))).toEqual({});
  });

  it('dispositivo inexistente → error', async () => {
    const { processor } = setup();
    await expect(processor.handle(job('read-live-configuration', { deviceId: 'nope' }))).rejects.toThrow('nope');
  });
});

describe('DeviceOpsProcessor: apply-live-configuration', () => {
  it('aplica en el equipo bajo el lock del dispositivo y registra los valores', async () => {
    const { processor, muxDriver, liveValues } = setup();
    muxDriver.applyLiveConfiguration.mockImplementation(async () => {
      expect(await redis.exists('lock:device:mux1')).toBe(1);
    });
    expect(await processor.handle(job('apply-live-configuration', { deviceId: 'mux1', values: { channel: 4 } }))).toBe(true);
    expect(muxDriver.applyLiveConfiguration).toHaveBeenCalledWith(
      { id: 'mux1', name: 'MUX', ip: '10.0.0.2', configuration: {} },
      { channel: 4 },
    );
    expect(await liveValues.read('mux1')).toEqual({ channel: 4 });
    expect(await redis.exists('lock:device:mux1')).toBe(0);
  });

  it('dispositivo midiendo → error con el mensaje del 409, sin tocar el equipo ni el ledger', async () => {
    const { processor, muxDriver, locks, liveValues } = setup();
    await locks.tryAcquire('lock:device:mux1', 60_000);
    await expect(processor.handle(job('apply-live-configuration', { deviceId: 'mux1', values: { channel: 4 } }))).rejects.toThrow(
      new ConflictException(deviceBusyMessage('MUX')),
    );
    expect(muxDriver.applyLiveConfiguration).not.toHaveBeenCalled();
    expect(await liveValues.read('mux1')).toEqual({});
  });

  it('el equipo rechaza el valor → no se registra', async () => {
    const { processor, muxDriver, liveValues } = setup();
    muxDriver.applyLiveConfiguration.mockRejectedValue(new Error('No se pudo activar el canal 4 del MUX'));
    await expect(processor.handle(job('apply-live-configuration', { deviceId: 'mux1', values: { channel: 4 } }))).rejects.toThrow('canal 4');
    expect(await liveValues.read('mux1')).toEqual({});
  });
});

describe('DeviceOpsProcessor: set-actuator-data', () => {
  const data = (values: Record<string, number>, actuatorId = 'kronos-mux-16-channel') => ({ deviceId: 'mux1', actuatorId, values });

  // Variante del MUX cuyo valor del actuator solo declara (o ninguna) de las cotas.
  const withBounds = (bounds: { rangeMinimum?: number; rangeMaximum?: number }) => {
    const { rangeMinimum, rangeMaximum, ...rest } = KRONOS_MUX_16.description.actuators[0].actuatorValues[0] as any;
    return {
      ...KRONOS_MUX_16,
      description: {
        ...KRONOS_MUX_16.description,
        actuators: [{ ...KRONOS_MUX_16.description.actuators[0], actuatorValues: [{ ...rest, ...bounds }] }],
      },
    } as typeof KRONOS_MUX_16;
  };

  it('solo comprueba las cotas que existen y no imprime undefined', async () => {
    const cases: Array<[{ rangeMinimum?: number; rangeMaximum?: number }, number, string]> = [
      [{ rangeMinimum: 1 }, 0, '"channel" debe ser ≥ 1'],
      [{ rangeMaximum: 16 }, 17, '"channel" debe ser ≤ 16'],
      [{}, NaN, '"channel" debe ser un número'],
    ];
    for (const [bounds, value, message] of cases) {
      const { processor } = setup(withBounds(bounds));
      await expect(processor.handle(job('set-actuator-data', data({ channel: value })))).rejects.toThrow(new BadRequestException(message));
    }
    const { processor, muxDriver } = setup(withBounds({ rangeMinimum: 1 }));
    await expect(processor.handle(job('set-actuator-data', data({ channel: 9999 })))).resolves.toBe(true);
    expect(muxDriver.setActuatorData).toHaveBeenCalled();
  });

  it('valida contra los rangos del actuator (mensaje 400)', async () => {
    const { processor, muxDriver } = setup();
    await expect(processor.handle(job('set-actuator-data', data({ channel: 17 })))).rejects.toThrow(
      new BadRequestException('"channel" debe estar entre 1 y 16'),
    );
    await expect(processor.handle(job('set-actuator-data', data({ channel: 0 })))).rejects.toThrow('"channel" debe estar entre 1 y 16');
    await expect(processor.handle(job('set-actuator-data', data({ channel: 'x' as any })))).rejects.toThrow('"channel" debe estar entre 1 y 16');
    await expect(processor.handle(job('set-actuator-data', data({ channel: 2 }, 'otro')))).rejects.toBeInstanceOf(BadRequestException);
    await expect(processor.handle(job('set-actuator-data', data({ foo: 2 })))).rejects.toBeInstanceOf(BadRequestException);
    expect(muxDriver.setActuatorData).not.toHaveBeenCalled();
  });

  it('aplica bajo el lock y registra los valores que coinciden con un parámetro live', async () => {
    const { processor, muxDriver, liveValues } = setup();
    muxDriver.setActuatorData.mockImplementation(async () => {
      expect(await redis.exists('lock:device:mux1')).toBe(1);
    });
    expect(await processor.handle(job('set-actuator-data', data({ channel: 5 })))).toBe(true);
    expect(muxDriver.setActuatorData).toHaveBeenCalledWith(
      { id: 'mux1', name: 'MUX', ip: '10.0.0.2', configuration: {} },
      'kronos-mux-16-channel',
      { channel: 5 },
    );
    expect(await liveValues.read('mux1')).toEqual({ channel: 5 });
  });

  it('dispositivo midiendo → error con el mensaje del 409', async () => {
    const { processor, locks, muxDriver } = setup();
    await locks.tryAcquire('lock:device:mux1', 60_000);
    await expect(processor.handle(job('set-actuator-data', data({ channel: 5 })))).rejects.toThrow(deviceBusyMessage('MUX'));
    expect(muxDriver.setActuatorData).not.toHaveBeenCalled();
  });
});

describe('DeviceOpsProcessor: otras operaciones', () => {
  it('nombre de operación desconocido → error', async () => {
    const { processor } = setup();
    await expect(processor.handle(job('reboot', {} as any))).rejects.toThrow('reboot');
  });
});

describe('ida y vuelta del 409: error del worker → job fallido de Bull → mapDeviceOpError de la API', () => {
  it('el failedReason del job conserva el texto y la API responde 409 con el mismo mensaje', async () => {
    const { processor, locks } = setup();
    await locks.tryAcquire('lock:device:mux1', 60_000);
    const err = await processor
      .handle(job('apply-live-configuration', { deviceId: 'mux1', values: { channel: 4 } }))
      .catch((e: Error) => e);

    // Bull (queue.processJob → job.moveToFailed(err)) fija failedReason = err.message antes de tocar Redis.
    const failed = Object.create(BullJob.prototype);
    failed.queue = { isReady: () => new Promise(() => undefined) };
    void BullJob.prototype.moveToFailed.call(failed, err);
    expect(failed.failedReason).toBe(deviceBusyMessage('MUX'));

    // La API recibe ese failedReason por el evento global:failed.
    const queue = Object.assign(new EventEmitter(), {
      add: jest.fn(async () => ({ id: '42', getState: jest.fn(async () => 'active') })),
      getJob: jest.fn(),
    });
    const client = new DeviceOpsClient(queue as any);
    setTimeout(() => queue.emit('global:failed', '42', failed.failedReason), 5);
    const apiErr = await client.request('apply-live-configuration', { deviceId: 'mux1', values: { channel: 4 } }, 500).catch((e) => e);

    const mapped = mapDeviceOpError(apiErr, 'MUX');
    expect(mapped).toBeInstanceOf(ConflictException);
    expect((mapped as ConflictException).getStatus()).toBe(409);
    expect(mapped.message).toBe(deviceBusyMessage('MUX'));
  });
});
