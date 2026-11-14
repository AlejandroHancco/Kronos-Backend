import { Test } from '@nestjs/testing';
import { RedisModule } from './redis.module';

describe('RedisModule', () => {
  const original = process.env.REDIS_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
  });

  it('fails fast without REDIS_URL', async () => {
    delete process.env.REDIS_URL;
    await expect(
      Test.createTestingModule({ imports: [RedisModule] }).compile(),
    ).rejects.toThrow(/REDIS_URL is required/);
  });
});
