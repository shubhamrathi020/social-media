import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import Redis from 'ioredis';

export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');

/** Shared infrastructure clients. Feature modules inject these instead of creating their own. */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) =>
        new Pool({ connectionString: cfg.getOrThrow<string>('DATABASE_URL') }),
    },
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) =>
        new Redis(cfg.getOrThrow<string>('REDIS_URL'), { lazyConnect: false, maxRetriesPerRequest: 2 }),
    },
  ],
  exports: [PG_POOL, REDIS],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Runs last, after feature modules stopped using the clients; open sockets would keep the process alive. */
  async onApplicationShutdown() {
    await Promise.allSettled([this.pg.end(), this.redis.quit()]);
  }
}
