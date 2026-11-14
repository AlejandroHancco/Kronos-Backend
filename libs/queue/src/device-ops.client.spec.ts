import { EventEmitter } from 'events';
import { DeviceOpFailedError, DeviceOpTimeoutError, DeviceOpsClient } from './device-ops.client';

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

/** Simula que el worker termina el job emitiendo el evento global de Bull (resultado serializado). */
function completeLater(queue: FakeQueue, jobId: string, result: unknown, delayMs = 5) {
  setTimeout(() => queue.emit('global:completed', jobId, JSON.stringify(result)), delayMs);
}

describe('DeviceOpsClient.request', () => {
  let queue: FakeQueue;
  let job: FakeJob;
  let client: DeviceOpsClient;

  beforeEach(() => {
    job = makeJob();
    queue = Object.assign(new EventEmitter(), {
      add: jest.fn().mockResolvedValue(job),
      getJob: jest.fn().mockImplementation(async () => job),
    });
    client = new DeviceOpsClient(queue as any);
  });

  const listenerCount = () => queue.listenerCount('global:completed') + queue.listenerCount('global:failed');

  it('resolves with the parsed worker result and enqueues with the retention options', async () => {
    completeLater(queue, '42', { a: 1 });

    const result = await client.request<{ a: number }>('read-live-configuration', { deviceId: 'd1' }, 500);

    expect(result).toEqual({ a: 1 });
    expect(queue.add).toHaveBeenCalledWith(
      'read-live-configuration',
      { deviceId: 'd1' },
      { attempts: 1, removeOnComplete: { age: 60 }, removeOnFail: { age: 60 } },
    );
    expect(job.remove).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
  });

  it('ignores global events for other job ids', async () => {
    completeLater(queue, '41', 'other', 1);
    completeLater(queue, '42', true, 10);
    await expect(client.request<boolean>('test-connection', { type: 'x', ip: '1', port: 1 }, 200)).resolves.toBe(true);
  });

  it('resolves from the job state when it finished before the listeners were attached', async () => {
    job = makeJob('completed', { returnvalue: true });
    queue.add.mockResolvedValue(job);
    await expect(client.request<boolean>('test-connection', { type: 'x', ip: '1', port: 1 }, 200)).resolves.toBe(true);
    expect(listenerCount()).toBe(0);
  });

  it('times out with DeviceOpTimeoutError, removes the still-waiting job and drops the listeners', async () => {
    await expect(client.request('test-connection', { type: 'x', ip: '1', port: 1 }, 30)).rejects.toBeInstanceOf(
      DeviceOpTimeoutError,
    );
    expect(job.remove).toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
  });

  it('on timeout does not remove a job the worker is already running', async () => {
    job.getState.mockResolvedValue('active');
    await expect(client.request('test-connection', { type: 'x', ip: '1', port: 1 }, 30)).rejects.toBeInstanceOf(
      DeviceOpTimeoutError,
    );
    expect(job.remove).not.toHaveBeenCalled();
  });

  it('swallows job.remove errors on the timeout path', async () => {
    job.remove.mockRejectedValue(new Error('x'));
    await expect(client.request('test-connection', { type: 'x', ip: '1', port: 1 }, 20)).rejects.toBeInstanceOf(
      DeviceOpTimeoutError,
    );
  });

  it('rejects with DeviceOpFailedError carrying the worker message when the job fails', async () => {
    setTimeout(() => queue.emit('global:failed', '42', 'boom'), 5);
    const err: any = await client.request('apply-live-configuration', { deviceId: 'd', values: {} }, 500).catch((e: any) => e);
    expect(err).toBeInstanceOf(DeviceOpFailedError);
    expect(err.message).toBe('boom');
    expect(listenerCount()).toBe(0);
  });

  it('rejects with DeviceOpFailedError when the job already failed before subscribing', async () => {
    job = makeJob('failed', { failedReason: 'device offline' });
    queue.add.mockResolvedValue(job);
    await expect(client.request('set-actuator-data', { deviceId: 'd', actuatorId: 'a', values: {} }, 200)).rejects.toThrow(
      new DeviceOpFailedError('device offline'),
    );
  });

  it('rejects with a timeout-like error (DeviceOpTimeoutError) when queue.add rejects (Redis down)', async () => {
    queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(client.request('test-connection', { type: 'x', ip: '1', port: 1 }, 200)).rejects.toBeInstanceOf(
      DeviceOpTimeoutError,
    );
    expect(listenerCount()).toBe(0);
  });

  it('bounds queue.add by the same timeout (Redis hung) → DeviceOpTimeoutError; a late job is removed', async () => {
    let resolveAdd!: (j: FakeJob) => void;
    queue.add.mockReturnValue(new Promise<FakeJob>((r) => (resolveAdd = r)));
    const started = Date.now();
    await expect(client.request('test-connection', { type: 'x', ip: '1', port: 1 }, 30)).rejects.toBeInstanceOf(
      DeviceOpTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(listenerCount()).toBe(0);
    resolveAdd(job);
    await new Promise((r) => setTimeout(r, 5));
    expect(job.remove).toHaveBeenCalled();
  });

  it('does not leave a pending timer after success', async () => {
    job = makeJob('completed', { returnvalue: true });
    queue.add.mockResolvedValue(job);
    jest.useFakeTimers();
    try {
      await client.request('test-connection', { type: 'x', ip: '1', port: 1 }, 10_000);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
