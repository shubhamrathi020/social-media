import { BadRequestException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import Redis from 'ioredis';
import { REDIS } from '../../common/infra.module';

const CODE_TTL_S = 300;
const RESEND_COOLDOWN_S = 30;
const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const tooMany = (msg: string) => new HttpException(msg, HttpStatus.TOO_MANY_REQUESTS);

/** Issues and checks one-time codes. Delivery is delegated to an OtpSender (SMS provider later). */
@Injectable()
export class OtpService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Returns the plaintext code so the caller can hand it to the SMS sender. */
  async issue(phone: string): Promise<string> {
    const cooldown = await this.redis.set(`otp:cool:${phone}`, '1', 'EX', RESEND_COOLDOWN_S, 'NX');
    if (cooldown !== 'OK') throw tooMany('Please wait before requesting another code');

    const count = await this.redis.incr(`otp:cnt:${phone}`);
    if (count === 1) await this.redis.expire(`otp:cnt:${phone}`, 3600);
    if (count > MAX_PER_HOUR) throw tooMany('Too many codes requested, try again later');

    const devCode = process.env.NODE_ENV !== 'production' ? process.env.OTP_DEV_CODE : undefined;
    const code = devCode ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis.set(`otp:code:${phone}`, sha256(code), 'EX', CODE_TTL_S);
    await this.redis.del(`otp:att:${phone}`);
    return code;
  }

  async verify(phone: string, code: string): Promise<void> {
    const stored = await this.redis.get(`otp:code:${phone}`);
    if (!stored) throw new BadRequestException('Invalid or expired code');

    const attempts = await this.redis.incr(`otp:att:${phone}`);
    if (attempts === 1) await this.redis.expire(`otp:att:${phone}`, CODE_TTL_S);
    if (attempts > MAX_ATTEMPTS) {
      await this.redis.del(`otp:code:${phone}`);
      throw tooMany('Too many attempts, request a new code');
    }

    const a = Buffer.from(stored);
    const b = Buffer.from(sha256(code));
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new BadRequestException('Invalid or expired code');
    }
    await this.redis.del(`otp:code:${phone}`, `otp:att:${phone}`);
  }
}
