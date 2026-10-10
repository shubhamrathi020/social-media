import { BadRequestException, HttpException } from '@nestjs/common';
import { OtpService } from './otp.service';

/** Minimal in-memory stand-in for the subset of ioredis that OtpService uses. */
class FakeRedis {
  store = new Map<string, string>();
  async set(k: string, v: string, ..._args: unknown[]) {
    if (_args.includes('NX') && this.store.has(k)) return null;
    this.store.set(k, v);
    return 'OK';
  }
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async incr(k: string) {
    const n = Number(this.store.get(k) ?? 0) + 1;
    this.store.set(k, String(n));
    return n;
  }
  async expire() {
    return 1;
  }
  async del(...keys: string[]) {
    keys.forEach((k) => this.store.delete(k));
    return keys.length;
  }
  clearCooldown(phone: string) {
    this.store.delete(`otp:cool:${phone}`);
  }
}

const PHONE = '+14155550123';

describe('OtpService', () => {
  let redis: FakeRedis;
  let svc: OtpService;

  beforeEach(() => {
    redis = new FakeRedis();
    svc = new OtpService(redis as any);
  });

  it('issues a 6 digit code that verifies once', async () => {
    const code = await svc.issue(PHONE);
    expect(code).toMatch(/^\d{6}$/);
    await expect(svc.verify(PHONE, code)).resolves.toBeUndefined();
    await expect(svc.verify(PHONE, code)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a wrong code', async () => {
    await svc.issue(PHONE);
    await expect(svc.verify(PHONE, '000000x')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces the resend cooldown', async () => {
    await svc.issue(PHONE);
    await expect(svc.issue(PHONE)).rejects.toMatchObject({ status: 429 });
  });

  it('locks out after too many wrong attempts', async () => {
    const code = await svc.issue(PHONE);
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) {
      await expect(svc.verify(PHONE, wrong)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(svc.verify(PHONE, code)).rejects.toBeInstanceOf(HttpException);
  });

  it('caps codes per hour', async () => {
    for (let i = 0; i < 5; i++) {
      await svc.issue(PHONE);
      redis.clearCooldown(PHONE);
    }
    await expect(svc.issue(PHONE)).rejects.toMatchObject({ status: 429 });
  });
});
