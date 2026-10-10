import { HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MetricsController, UnhandledErrorFilter } from './observability.module';

function fakeRes() {
  const res: any = { headersSent: false, headers: {} as Record<string, string> };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.send = (b: unknown) => ((res.body = b), res);
  res.setHeader = (k: string, v: string) => (res.headers[k] = v);
  return res;
}

describe('MetricsController', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('serves Prometheus text when no token is configured outside production', async () => {
    delete process.env.METRICS_TOKEN;
    process.env.NODE_ENV = 'development';
    const res = fakeRes();
    await new MetricsController().metrics(undefined, res);
    expect(res.headers['Content-Type']).toMatch(/text\/plain/);
    expect(res.body).toContain('process_cpu_user_seconds_total');
  });

  it('is off in production without a token', async () => {
    delete process.env.METRICS_TOKEN;
    process.env.NODE_ENV = 'production';
    await expect(new MetricsController().metrics(undefined, fakeRes())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires the bearer token when one is set', async () => {
    process.env.METRICS_TOKEN = 'secret-token';
    await expect(new MetricsController().metrics('Bearer wrong', fakeRes())).rejects.toBeInstanceOf(UnauthorizedException);
    const res = fakeRes();
    await new MetricsController().metrics('Bearer secret-token', res);
    expect(res.body).toContain('http_request_duration_seconds');
  });
});

describe('UnhandledErrorFilter', () => {
  const host = (req: any, res: any) =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    }) as any;

  it('turns unexpected errors into a 500 that carries the request id and no internals', () => {
    const res = fakeRes();
    const filter = new UnhandledErrorFilter();
    (filter as any).log = { error: jest.fn() };
    filter.catch(new Error('db password is hunter2'), host({ id: 'req-12345678', method: 'GET', originalUrl: '/v1/x', baseUrl: '' }, res));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error', requestId: 'req-12345678' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('leaves HTTP exceptions to the default handler', () => {
    const filter = new UnhandledErrorFilter();
    const spy = jest.spyOn(Object.getPrototypeOf(UnhandledErrorFilter.prototype), 'catch').mockImplementation(() => undefined);
    filter.catch(new HttpException('nope', 418), host({}, fakeRes()));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
