import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { assertSafeConfig } from './common/config-check';
import { initSentry } from './modules/observability/observability.module';

/** Time allowed for in-flight work (requests, media jobs) to finish after SIGTERM before exiting anyway. */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 10_000);

async function bootstrap() {
  assertSafeConfig(process.env);
  initSentry();

  // rawBody is needed to verify LiveKit webhook signatures.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Behind a load balancer set TRUST_PROXY=1 so rate limits see the real client IP.
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
  }
  app.use(helmet());
  // Browsers only (native apps ignore CORS): the moderator page is same-origin; CORS_ORIGINS lists other web
  // origins, e.g. the Expo web build used for local testing. Outside production any origin is allowed.
  const origins = process.env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
  if (origins?.length || process.env.NODE_ENV !== 'production') {
    app.enableCors({ origin: origins?.length ? origins : true, exposedHeaders: ['X-Request-Id', 'Retry-After'] });
  }
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Graceful shutdown: stop accepting work, let modules close queues/sockets/clients, then exit. A hard deadline
  // guarantees the process ends even if something hangs, so deploys and restarts never wait on a stuck instance.
  const log = new Logger('Shutdown');
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.log(`${signal} received, shutting down`);
    setTimeout(() => {
      log.warn(`still running after ${SHUTDOWN_GRACE_MS} ms, exiting anyway`);
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    try {
      await app.close();
      log.log('shutdown complete');
      process.exit(0);
    } catch (e) {
      log.error(`shutdown failed: ${(e as Error).message}`);
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`API listening on :${port}`);
}
bootstrap();
