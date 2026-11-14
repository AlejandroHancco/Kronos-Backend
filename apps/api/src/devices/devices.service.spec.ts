import { Logger } from '@nestjs/common';
import { DevicesService } from './devices.service';

describe('DevicesService.testConnection', () => {
  let queue: { add: jest.Mock };
  let service: DevicesService;
  const originalTimeout = process.env.DEVICE_TEST_TIMEOUT_MS;

  beforeEach(() => {
    queue = { add: jest.fn() };
    service = new DevicesService({} as any, {} as any, queue as any);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalTimeout === undefined) delete process.env.DEVICE_TEST_TIMEOUT_MS;
    else process.env.DEVICE_TEST_TIMEOUT_MS = originalTimeout;
  });

  it('returns success when the worker job resolves true', async () => {
    const job = { finished: jest.fn().mockResolvedValue(true), remove: jest.fn() };
    queue.add.mockResolvedValue(job);

    const result = await service.testConnection({ type: 'analyzer', ip: '10.0.0.5', port: 3570 } as any);

    expect(result).toEqual({ success: true, message: 'Hioki IM3570 encontrado en 10.0.0.5:3570' });
    expect(queue.add).toHaveBeenCalledWith(
      'test-connection',
      { type: 'analyzer', ip: '10.0.0.5', port: 3570 },
      { attempts: 1, removeOnComplete: true, removeOnFail: true },
    );
    expect(job.remove).not.toHaveBeenCalled();
  });

  it('returns MUX success message', async () => {
    queue.add.mockResolvedValue({ finished: jest.fn().mockResolvedValue(true), remove: jest.fn() });
    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(result).toEqual({ success: true, message: 'MUX encontrado en 10.0.0.6' });
  });

  it('returns failure when the worker job resolves false', async () => {
    queue.add.mockResolvedValue({ finished: jest.fn().mockResolvedValue(false), remove: jest.fn() });
    const result = await service.testConnection({ type: 'analyzer', ip: '10.0.0.5', port: 3570 } as any);
    expect(result).toEqual({
      success: false,
      message: 'No se pudo conectar al analyzer en 10.0.0.5:3570',
    });
  });

  it('times out, removes the job and reports failure', async () => {
    process.env.DEVICE_TEST_TIMEOUT_MS = '50';
    const job = { finished: jest.fn(() => new Promise(() => undefined)), remove: jest.fn().mockResolvedValue(undefined) };
    queue.add.mockResolvedValue(job);

    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);

    expect(result).toEqual({ success: false, message: 'No se pudo conectar al MUX en 10.0.0.6' });
    expect(job.remove).toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });

  it('swallows job.remove errors on the failure path', async () => {
    process.env.DEVICE_TEST_TIMEOUT_MS = '20';
    const job = { finished: jest.fn(() => new Promise(() => undefined)), remove: jest.fn().mockRejectedValue(new Error('x')) };
    queue.add.mockResolvedValue(job);
    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(result.success).toBe(false);
  });

  it('returns failure without throwing when queue.add rejects (Redis down)', async () => {
    queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(result).toEqual({ success: false, message: 'No se pudo conectar al MUX en 10.0.0.6' });
  });

  it('returns failure when job.finished rejects', async () => {
    const job = { finished: jest.fn().mockRejectedValue(new Error('boom')), remove: jest.fn().mockResolvedValue(undefined) };
    queue.add.mockResolvedValue(job);
    const result = await service.testConnection({ type: 'analyzer', ip: '1.1.1.1', port: 1 } as any);
    expect(result.success).toBe(false);
    expect(job.remove).toHaveBeenCalled();
  });

  it('does not leave a pending timer after success', async () => {
    jest.useFakeTimers();
    try {
      queue.add.mockResolvedValue({ finished: jest.fn().mockResolvedValue(true), remove: jest.fn() });
      await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
