import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { assertSafeConfig } from './common/config-check';
import { initSentry } from './modules/observability/observability.module';

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
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`API listening on :${port}`);
}
bootstrap();
