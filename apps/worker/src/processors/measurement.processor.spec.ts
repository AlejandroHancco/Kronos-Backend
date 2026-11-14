import type { Job } from 'bull';
import type { MeasurementJobData } from '@app/queue';
import { MeasurementProcessor } from './measurement.processor';

describe('MeasurementProcessor.handleExecute', () => {
  it('runs measureTask under the preference device locks and emits processing then completed', async () => {
    const order: string[] = [];
    const executor: any = {
      measureTask: jest.fn().mockImplementation(async () => {
        order.push('measure');
        return { ok: true };
      }),
    };
    const realtime: any = {
      jobStatus: jest.fn().mockImplementation((_u, s) => order.push(`status:${s.status}`)),
    };
    const prisma: any = {
      taskPreference: {
        findFirst: jest.fn().mockResolvedValue({ analyzerDeviceId: 'an1', muxDeviceId: 'mux1' }),
      },
      scheduledJob: { update: jest.fn() },
    };
    const lockService: any = {
      withDeviceLocks: jest.fn().mockImplementation(async (_ids, fn) => {
        order.push('lock');
        return fn();
      }),
    };
    const processor = new MeasurementProcessor(executor, realtime, prisma, lockService);
    const job = {
      id: 77,
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: {
        taskId: 5,
        userId: 'u1',
        ranges: [],
        selectedChannels: [1],
        jobId: 'manual-1',
        estimatedSeconds: 10,
      },
    } as unknown as Job<MeasurementJobData>;

    const result = await processor.handleExecute(job);

    expect(result).toEqual({ ok: true });
    expect(lockService.withDeviceLocks).toHaveBeenCalledWith(['mux1', 'an1'], expect.any(Function));
    expect(executor.measureTask).toHaveBeenCalledWith(5, 'u1', expect.objectContaining({ jobId: 'manual-1' }));
    expect(order).toEqual(['status:processing', 'lock', 'measure', 'status:completed']);
    const statuses = realtime.jobStatus.mock.calls.map(([userId, s]) => [userId, s.status, s.jobId]);
    expect(statuses).toEqual([
      ['u1', 'processing', '77'],
      ['u1', 'completed', '77'],
    ]);
  });
});
