import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConsoleOtpSender } from './otp-sender';
import { HttpOtpSender, SmsGateOtpSender, createOtpSender, renderMessage } from './sms-senders';

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let base: string;
let seen: Seen[];
let status = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.statusCode = status;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  seen = [];
  status = 200;
});

const cfg = { template: 'Your {app} code is {code}.', appName: 'Social' };

describe('renderMessage', () => {
  it('fills the template', () => {
    expect(renderMessage(cfg, '123456')).toBe('Your Social code is 123456.');
  });
});

describe('SmsGateOtpSender', () => {
  it('posts the documented body with basic auth', async () => {
    await new SmsGateOtpSender({ baseUrl: base + '/', username: 'u', password: 'p' }, cfg).send('+14155550123', '654321');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/message');
    expect(seen[0].headers.authorization).toBe('Basic ' + Buffer.from('u:p').toString('base64'));
    expect(JSON.parse(seen[0].body)).toEqual({
      textMessage: { text: 'Your Social code is 654321.' },
      phoneNumbers: ['+14155550123'],
    });
  });

  it('maps provider failures to a generic 503 without leaking details', async () => {
    status = 500;
    const p = new SmsGateOtpSender({ baseUrl: base, username: 'u', password: 'p' }, cfg).send('+14155550123', '111111');
    await expect(p).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(p).rejects.not.toThrow(/500|111111/);
  });
});

describe('HttpOtpSender', () => {
  it('substitutes and JSON-escapes placeholders', async () => {
    const sender = new HttpOtpSender(
      { url: base + '/sms', bodyTemplate: '{"to":"{phone}","text":"{message}","otp":"{code}"}', headers: { 'x-key': 'k' } },
      { template: 'say "hi" {code}', appName: 'Social' },
    );
    await sender.send('+14155550123', '999000');
    expect(seen[0].headers['x-key']).toBe('k');
    expect(JSON.parse(seen[0].body)).toEqual({ to: '+14155550123', text: 'say "hi" 999000', otp: '999000' });
  });
});

describe('createOtpSender', () => {
  const fallback = () => new ConsoleOtpSender();

  it('defaults to the console sender', () => {
    expect(createOtpSender({}, fallback)).toBeInstanceOf(ConsoleOtpSender);
  });

  it('fails fast on missing provider settings', () => {
    expect(() => createOtpSender({ SMS_PROVIDER: 'twilio' }, fallback)).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => createOtpSender({ SMS_PROVIDER: 'smsgate' }, fallback)).toThrow(/SMSGATE_URL/);
    expect(() => createOtpSender({ SMS_PROVIDER: 'nope' }, fallback)).toThrow(/Unknown SMS_PROVIDER/);
  });

  it('requires a sender for Twilio', () => {
    expect(() =>
      createOtpSender({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }, fallback),
    ).toThrow(/TWILIO_FROM/);
  });
});
