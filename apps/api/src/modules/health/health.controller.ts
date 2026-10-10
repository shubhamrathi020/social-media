import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL, REDIS } from '../../common/infra.module';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async check() {
    const [db, cache] = await Promise.allSettled([this.pg.query('SELECT 1'), this.redis.ping()]);
    const status = {
      postgres: db.status === 'fulfilled' ? 'up' : 'down',
      redis: cache.status === 'fulfilled' ? 'up' : 'down',
    };
    if (status.postgres === 'down' || status.redis === 'down') {
      throw new ServiceUnavailableException(status);
    }
    return { status: 'ok', ...status };
  }
}
