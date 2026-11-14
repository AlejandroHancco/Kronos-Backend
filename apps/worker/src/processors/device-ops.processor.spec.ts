import type { Job } from 'bull';
import type { TestConnectionJobData } from '@app/queue';
import { DeviceOpsProcessor } from './device-ops.processor';

function job(data: TestConnectionJobData): Job<TestConnectionJobData> {
  return { id: 1, data } as unknown as Job<TestConnectionJobData>;
}

describe('DeviceOpsProcessor', () => {
  it('delegates a known type to its plugin and returns its result', async () => {
    const plugin = { testConnection: jest.fn().mockResolvedValue(true) };
    const registry: any = { has: jest.fn().mockReturnValue(true), get: jest.fn().mockReturnValue(plugin) };
    const processor = new DeviceOpsProcessor(registry);

    const result = await processor.handle(job({ type: 'analyzer', ip: '10.0.0.5', port: 3570 }));

    expect(result).toBe(true);
    expect(registry.get).toHaveBeenCalledWith('analyzer');
    expect(plugin.testConnection).toHaveBeenCalledWith('10.0.0.5', 'analyzer', 3570);
  });

  it('returns false for an unknown type without calling any plugin', async () => {
    const registry: any = { has: jest.fn().mockReturnValue(false), get: jest.fn() };
    const processor = new DeviceOpsProcessor(registry);

    const result = await processor.handle(job({ type: 'toaster', ip: '10.0.0.9', port: 1 }));

    expect(result).toBe(false);
    expect(registry.get).not.toHaveBeenCalled();
  });
});
