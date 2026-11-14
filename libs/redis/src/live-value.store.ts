import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import type { ConfigurationValues } from '@app/laas-catalog';
import { REDIS_CLIENT } from './redis.constants';

const UPDATED_AT = 'updatedAt';

/**
 * Últimos valores 'live' conocidos por dispositivo (los drivers no guardan estado). Hash
 * `live:<deviceId>`: un campo por parámetro (valor en JSON para conservar number/string/boolean)
 * más `updatedAt` (ISO).
 */
@Injectable()
export class LiveValueStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async record(deviceId: string, values: ConfigurationValues): Promise<void> {
    const fields: Record<string, string> = { [UPDATED_AT]: new Date().toISOString() };
    for (const [name, value] of Object.entries(values)) {
      if (name !== UPDATED_AT) fields[name] = JSON.stringify(value);
    }
    await this.redis.hset(`live:${deviceId}`, fields);
  }

  async read(deviceId: string): Promise<ConfigurationValues> {
    const raw = await this.redis.hgetall(`live:${deviceId}`);
    const values: ConfigurationValues = {};
    for (const [name, json] of Object.entries(raw)) {
      if (name === UPDATED_AT) continue;
      try {
        values[name] = JSON.parse(json);
      } catch {
        // campo corrupto: se ignora
      }
    }
    return values;
  }
}
