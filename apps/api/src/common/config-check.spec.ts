import { assertSafeConfig } from './config-check';

const base = {
  DATABASE_URL: 'postgresql://x',
  REDIS_URL: 'redis://x',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  S3_ENDPOINT: 'http://s3',
  S3_BUCKET: 'b',
};

describe('assertSafeConfig', () => {
  it('accepts a complete development config', () => {
    expect(() => assertSafeConfig({ ...base, NODE_ENV: 'development' })).not.toThrow();
  });

  it('lists every missing variable', () => {
    expect(() => assertSafeConfig({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL.*\n.*REDIS_URL/s);
  });

  it('rejects placeholder or short secrets in production', () => {
    expect(() => assertSafeConfig({ ...base, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'change-me' })).toThrow(
      /at least 32/,
    );
    expect(() =>
      assertSafeConfig({
        ...base,
        NODE_ENV: 'production',
        LIVEKIT_API_SECRET: 'devsecret-devsecret-devsecret-devsecret',
      }),
    ).toThrow(/LIVEKIT_API_SECRET/);
  });

  it('refuses a fixed OTP code in production', () => {
    expect(() => assertSafeConfig({ ...base, NODE_ENV: 'production', OTP_DEV_CODE: '123456' })).toThrow(
      /OTP_DEV_CODE/,
    );
  });

  it('allows the same placeholders outside production', () => {
    expect(() => assertSafeConfig({ ...base, NODE_ENV: 'development', OTP_DEV_CODE: '123456' })).not.toThrow();
  });
});
