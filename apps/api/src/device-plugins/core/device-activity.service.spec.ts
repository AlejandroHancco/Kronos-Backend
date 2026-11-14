import { DeviceActivityService } from './device-activity.service';

const prisma = (running: string[] = []) => ({
  scheduledJob: { findMany: jest.fn(async () => (running.length ? [{ taskId: 1 }] : [])) },
  taskPreference: {
    findMany: jest.fn(async () => (running.length ? [{ sensorDeviceId: running[0], channelSelectorDeviceId: running[1] ?? null }] : [])),
  },
});

describe('DeviceActivityService', () => {
  it('busy mientras mide y libera con release idempotente', async () => {
    const a = new DeviceActivityService(prisma() as any);
    const release = await a.beginMeasurement(['s', 'm']);
    expect(a.isMeasuring('m')).toBe(true);
    expect(await a.isBusy('m')).toBe(true);
    release();
    release();
    expect(await a.isBusy('m')).toBe(false);
  });

  it('cuenta mediciones simultáneas sobre el mismo dispositivo', async () => {
    const a = new DeviceActivityService(prisma() as any);
    const r1 = await a.beginMeasurement(['m']);
    const r2 = await a.beginMeasurement(['m']);
    r1();
    expect(a.isMeasuring('m')).toBe(true);
    r2();
    expect(a.isMeasuring('m')).toBe(false);
  });

  it('busy si un job programado running usa el dispositivo', async () => {
    expect(await new DeviceActivityService(prisma(['s', 'm']) as any).isBusy('m')).toBe(true);
    expect(await new DeviceActivityService(prisma(['s', 'm']) as any).isBusy('x')).toBe(false);
  });

  it('runConfiguration: 409 si mide o si hay otra configuración en curso', async () => {
    const a = new DeviceActivityService(prisma() as any);
    const release = await a.beginMeasurement(['m']);
    await expect(a.runConfiguration({ id: 'm', name: 'MUX' }, async () => 1)).rejects.toThrow(
      '"MUX" está midiendo; espera a que termine para cambiar su configuración',
    );
    release();
    let unblock!: () => void;
    const slow = a.runConfiguration({ id: 'm', name: 'MUX' }, () => new Promise<void>((r) => (unblock = r)));
    await expect(a.runConfiguration({ id: 'm', name: 'MUX' }, async () => 1)).rejects.toThrow(
      'Ya hay un cambio de configuración en curso para "MUX"',
    );
    await Promise.resolve();
    unblock();
    await slow;
    await expect(a.runConfiguration({ id: 'm', name: 'MUX' }, async () => 2)).resolves.toBe(2);
  });

  it('runConfiguration libera el dispositivo aunque fn falle', async () => {
    const a = new DeviceActivityService(prisma() as any);
    await expect(a.runConfiguration({ id: 'm', name: 'MUX' }, async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(a.runConfiguration({ id: 'm', name: 'MUX' }, async () => 1)).resolves.toBe(1);
  });

  it('beginMeasurement espera a la configuración en curso', async () => {
    const a = new DeviceActivityService(prisma() as any);
    const order: string[] = [];
    let unblock!: () => void;
    const cfg = a.runConfiguration({ id: 'm', name: 'MUX' }, () => new Promise<void>((r) => (unblock = () => { order.push('cfg'); r(); })));
    const meas = a.beginMeasurement(['m']).then((rel) => { order.push('measure'); rel(); });
    await new Promise((r) => setImmediate(r));
    unblock();
    await Promise.all([cfg, meas]);
    expect(order).toEqual(['cfg', 'measure']);
  });
});
