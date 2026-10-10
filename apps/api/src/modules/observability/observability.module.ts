import {
  ArgumentsHost,
  Catch,
  Controller,
  Get,
  Headers,
  HttpException,
  Injectable,
  Logger,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NotFoundException,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_FILTER, BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { randomUUID, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { httpDuration, httpErrors, registry } from './metrics';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Gives every request an id (kept from X-Request-Id when the caller or load balancer sent a sane one),
 * returns it in the response, records timing metrics and writes one access-log line per request.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly log = new Logger('HTTP');
  private readonly quiet = new Set(['/v1/health', '/v1/metrics']);

  use(req: Request & { id?: string; user?: { userId: string } }, res: Response, next: NextFunction) {
    const incoming = req.header('x-request-id');
    req.id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      // Route pattern (e.g. /v1/posts/:id), not the raw URL, so metrics do not explode in cardinality.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      httpDuration.labels(req.method, route, String(res.statusCode)).observe(seconds);
      if (this.quiet.has(req.path)) return;
      const line = `${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${(seconds * 1000).toFixed(1)}ms rid=${req.id}${req.user ? ` user=${req.user.userId}` : ''}`;
      if (res.statusCode >= 500) this.log.error(line);
      else this.log.log(line);
    });
    next();
  }
}

/**
 * Unexpected errors: log the stack with the request id, report to Sentry when configured, and answer with a
 * generic 500 that carries the request id so a user report can be matched to the log line.
 */
@Catch()
export class UnhandledErrorFilter extends BaseExceptionFilter {
  private readonly log = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http' || exception instanceof HttpException) {
      return super.catch(exception, host);
    }
    const req = host.switchToHttp().getRequest<Request & { id?: string; user?: { userId: string } }>();
    const res = host.switchToHttp().getResponse<Response>();
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    httpErrors.labels(route).inc();
    this.log.error(`rid=${req.id} ${req.method} ${req.originalUrl}: ${(exception as Error)?.stack ?? exception}`);
    if (process.env.SENTRY_DSN) {
      Sentry.withScope((scope) => {
        scope.setTag('request_id', req.id ?? '');
        if (req.user) scope.setUser({ id: req.user.userId });
        Sentry.captureException(exception);
      });
    }
    if (!res.headersSent) {
      res.status(500).json({ statusCode: 500, message: 'Internal server error', requestId: req.id });
    }
  }
}

/**
 * Prometheus scrape endpoint. Requires `Authorization: Bearer $METRICS_TOKEN` when METRICS_TOKEN is set,
 * and is switched off in production unless it is set.
 */
@Controller('metrics')
export class MetricsController {
  @Get()
  async metrics(@Headers('authorization') auth: string | undefined, @Res() res: Response) {
    const token = process.env.METRICS_TOKEN;
    if (!token) {
      if (process.env.NODE_ENV === 'production') throw new NotFoundException();
    } else {
      const given = Buffer.from(auth?.replace(/^Bearer /, '') ?? '');
      const want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new UnauthorizedException();
    }
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }
}

@Module({
  controllers: [MetricsController],
  providers: [{ provide: APP_FILTER, useClass: UnhandledErrorFilter }],
})
export class ObservabilityModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

/** Call before the app is created. No-op unless SENTRY_DSN is set. */
export function initSentry(env: NodeJS.ProcessEnv = process.env) {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV ?? 'development',
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // Phone numbers and message text must not leave the server in error reports.
    sendDefaultPii: false,
  });
}
