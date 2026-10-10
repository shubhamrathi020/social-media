import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok when postgres and redis respond', async () => {
    const c = new HealthController({ query: async () => ({}) } as any, { ping: async () => 'PONG' } as any);
    await expect(c.check()).resolves.toEqual({ status: 'ok', postgres: 'up', redis: 'up' });
  });

  it('throws 503 when a dependency is down', async () => {
    const c = new HealthController(
      { query: async () => { throw new Error('x'); } } as any,
      { ping: async () => 'PONG' } as any,
    );
    await expect(c.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
