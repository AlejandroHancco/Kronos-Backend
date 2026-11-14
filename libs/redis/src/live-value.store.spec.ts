import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { LiveValueStore } from './live-value.store';

describe('LiveValueStore', () => {
  let redis: Redis;
  let store: LiveValueStore;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    store = new LiveValueStore(redis);
  });
  afterEach(() => redis.disconnect());

  it('record/read round-trip conserva number, string y boolean', async () => {
    await store.record('d1', { channel: 3, mode: 'ZS', on: true, off: false });
    expect(await store.read('d1')).toEqual({ channel: 3, mode: 'ZS', on: true, off: false });
  });

  it('record guarda updatedAt en live:<id> y no lo devuelve como valor', async () => {
    await store.record('d1', { channel: 3 });
    expect(await redis.hget('live:d1', 'updatedAt')).toEqual(expect.any(String));
    expect(await store.read('d1')).toEqual({ channel: 3 });
  });

  it('record fusiona con valores previos y sobrescribe', async () => {
    await store.record('d1', { channel: 3, mode: 'A' });
    await store.record('d1', { channel: 4 });
    expect(await store.read('d1')).toEqual({ channel: 4, mode: 'A' });
  });

  it('read de un dispositivo sin valores: {}', async () => {
    expect(await store.read('nope')).toEqual({});
  });
});
