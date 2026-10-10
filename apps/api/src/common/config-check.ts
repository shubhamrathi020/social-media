const REQUIRED = ['DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'S3_ENDPOINT', 'S3_BUCKET'] as const;

const PLACEHOLDERS = new Set(['change-me', 'change-me-too', 'devsecret-devsecret-devsecret-devsecret']);

/**
 * Fails fast at boot instead of at the first request. In production it also refuses the
 * placeholder secrets that ship in .env.example.
 */
export function assertSafeConfig(env: NodeJS.ProcessEnv) {
  const problems: string[] = [];
  for (const k of REQUIRED) if (!env[k]) problems.push(`${k} is not set`);

  if (env.NODE_ENV === 'production') {
    const secret = env.JWT_ACCESS_SECRET ?? '';
    if (secret.length < 32) problems.push('JWT_ACCESS_SECRET must be at least 32 characters in production');
    if (PLACEHOLDERS.has(secret)) problems.push('JWT_ACCESS_SECRET is still the example placeholder');
    if (PLACEHOLDERS.has(env.LIVEKIT_API_SECRET ?? '')) problems.push('LIVEKIT_API_SECRET is still the dev default');
    if (env.OTP_DEV_CODE) problems.push('OTP_DEV_CODE must not be set in production');
    if ((env.SMS_PROVIDER ?? 'console') === 'console') {
      problems.push('SMS_PROVIDER must be twilio, smsgate or http in production (console only logs the code)');
    }
  }
  if (problems.length) {
    throw new Error(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }
}
