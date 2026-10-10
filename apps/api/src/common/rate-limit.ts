import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { REDIS } from './infra.module';

interface Limit {
  max: number;
  windowSeconds: number;
  bucket: string;
}

const KEY = 'rate-limit';

/** Stricter (or looser) limit for one route. Applies per user, or per IP for unauthenticated calls. */
export const RateLimit = (max: number, windowSeconds: number, bucket: string) =>
  SetMetadata(KEY, { max, windowSeconds, bucket } satisfies Limit);

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * Fixed-window rate limiter in Redis, applied to every HTTP route.
 * Defaults are generous; the point is stopping scripts and abuse, not shaping normal use.
 * Tune with RATE_LIMIT_USER_PER_MIN and RATE_LIMIT_IP_PER_MIN.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly perUser = num(process.env.RATE_LIMIT_USER_PER_MIN, 600);
  private readonly perIp = num(process.env.RATE_LIMIT_IP_PER_MIN, 120);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();

    // Identify the caller without enforcing auth (that is the auth guard's job).
    let subject = `ip:${req.ip}`;
    let defaultMax = this.perIp;
    const header: string | undefined = req.headers['authorization'];
    if (header?.startsWith('Bearer ')) {
      try {
        const p = await this.jwt.verifyAsync<{ sub: string }>(header.slice(7));
        subject = `user:${p.sub}`;
        defaultMax = this.perUser;
      } catch {
        /* fall back to IP */
      }
    }

    const override = this.reflector.get<Limit | undefined>(KEY, ctx.getHandler());
    const max = override?.max ?? defaultMax;
    const windowSeconds = override?.windowSeconds ?? 60;
    const key = `rl:${override?.bucket ?? 'all'}:${subject}`;

    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, windowSeconds);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - n)));
    if (n > max) {
      const ttl = await this.redis.ttl(key);
      res.setHeader('Retry-After', String(Math.max(ttl, 1)));
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
