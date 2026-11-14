import { EventEmitter } from 'events';
import { Logger } from '@nestjs/common';
import { DevicesService } from './devices.service';

type FakeJob = {
  id: string;
  returnvalue?: unknown;
  failedReason?: string;
  getState: jest.Mock;
  remove: jest.Mock;
};

type FakeQueue = EventEmitter & { add: jest.Mock; getJob: jest.Mock };

function makeJob(state = 'waiting', extra: Partial<FakeJob> = {}): FakeJob {
  return {
    id: '42',
    getState: jest.fn().mockResolvedValue(state),
    remove: jest.fn().mockResolvedValue(undefined),
    ...extra,
  };
}

/** Simula que el worker termina el job emitiendo el evento global de Bull. */
function completeLater(queue: FakeQueue, jobId: string, result: unknown, delayMs = 5) {
  setTimeout(() => queue.emit('global:completed', jobId, JSON.stringify(result)), delayMs);
}

describe('DevicesService.testConnection', () => {
  let queue: FakeQueue;
  let job: FakeJob;
  let service: DevicesService;
  const originalTimeout = process.env.DEVICE_TEST_TIMEOUT_MS;

  beforeEach(() => {
    job = makeJob();
    queue = Object.assign(new EventEmitter(), {
      add: jest.fn().mockResolvedValue(job),
      getJob: jest.fn().mockImplementation(async () => job),
    });
    service = new DevicesService({} as any, {} as any, queue as any);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalTimeout === undefined) delete process.env.DEVICE_TEST_TIMEOUT_MS;
    else process.env.DEVICE_TEST_TIMEOUT_MS = originalTimeout;
  });

  const listenerCount = () =>
    queue.listenerCount('global:completed') + queue.listenerCount('global:failed');

  it('returns success when the worker job completes with true', async () => {
    completeLater(queue, '42', true);

    const result = await service.testConnection({ type: 'analyzer', ip: '10.0.0.5', port: 3570 } as any);

    expect(result).toEqual({ success: true, message: 'Hioki IM3570 encontrado en 10.0.0.5:3570' });
    expect(queue.add).toHaveBeenCalledWith(
      'test-connection',
      { type: 'analyzer', ip: '10.0.0.5', port: 3570 },
      { attempts: 1, removeOnComplete: { age: 60 }, removeOnFail: { age: 60 } },
    );
    expect(job.remove).not.toHaveBeenCalled();
  });

  it('returns MUX success message', async () => {
    completeLater(queue, '42', true);
    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(result).toEqual({ success: true, message: 'MUX encontrado en 10.0.0.6' });
  });

  it('returns failure when the worker job completes with false', async () => {
    completeLater(queue, '42', false);
    const result = await service.testConnection({ type: 'analyzer', ip: '10.0.0.5', port: 3570 } as any);
    expect(result).toEqual({
      success: false,
      message: 'No se pudo conectar al analyzer en 10.0.0.5:3570',
    });
  });

  it('ignores global events for other job ids', async () => {
    process.env.DEVICE_TEST_TIMEOUT_MS = '200';
    completeLater(queue, '41', true, 1);
    completeLater(queue, '42', false, 10);
    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(result.success).toBe(false);
  });

  it('resolves from the job state when it finished before the listeners were attached', async () => {
    job = makeJob('completed', { returnvalue: true });
    queue.add.mockResolvedValue(job);
    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(result).toEqual({ success: true, message: 'MUX encontrado en 10.0.0.6' });
    expect(listenerCount()).toBe(0);
  });

  it('times out, removes the still-waiting job and reports failure', async () => {
    process.env.DEVICE_TEST_TIMEOUT_MS = '50';

    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);

    expect(result).toEqual({ success: false, message: 'No se pudo conectar al MUX en 10.0.0.6' });
    expect(job.remove).toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });

  it('on timeout does not remove a job the worker is already running', async () => {
    process.env.DEVICE_TEST_TIMEOUT_MS = '30';
    job.getState.mockResolvedValue('active');
    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(result.success).toBe(false);
    expect(job.remove).not.toHaveBeenCalled();
  });

  it('does not leave queue listeners behind after a timeout (no finished() watchdog)', async () => {
    process.env.DEVICE_TEST_TIMEOUT_MS = '20';
    await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(listenerCount()).toBe(0);
  });

  it('does not leave queue listeners behind after success', async () => {
    completeLater(queue, '42', true);
    await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(listenerCount()).toBe(0);
  });

  it('swallows job.remove errors on the failure path', async () => {
    process.env.DEVICE_TEST_TIMEOUT_MS = '20';
    job.remove.mockRejectedValue(new Error('x'));
    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(result.success).toBe(false);
  });

  it('returns failure without throwing when queue.add rejects (Redis down)', async () => {
    queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
    expect(result).toEqual({ success: false, message: 'No se pudo conectar al MUX en 10.0.0.6' });
  });

  it('returns failure when the worker job fails', async () => {
    setTimeout(() => queue.emit('global:failed', '42', 'boom'), 5);
    const result = await service.testConnection({ type: 'analyzer', ip: '1.1.1.1', port: 1 } as any);
    expect(result.success).toBe(false);
    expect(Logger.prototype.warn).toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
  });

  it('does not leave a pending timer after success', async () => {
    job = makeJob('completed', { returnvalue: true });
    queue.add.mockResolvedValue(job);
    jest.useFakeTimers();
    try {
      await service.testConnection({ type: 'mux', ip: '10.0.0.6' } as any);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
