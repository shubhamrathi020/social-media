import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** One registry for the process. Exposed at GET /v1/metrics in Prometheus text format. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration by route',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpErrors = new Counter({
  name: 'http_unhandled_errors_total',
  help: 'Requests that failed with an unexpected (non-HTTP) error',
  labelNames: ['route'] as const,
  registers: [registry],
});

export const socketConnections = new Gauge({
  name: 'socket_connections',
  help: 'Open Socket.IO connections on this instance',
  registers: [registry],
});

export const queueJobs = new Gauge({
  name: 'queue_jobs',
  help: 'Background jobs by queue and state',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
});
