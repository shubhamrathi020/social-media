import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { OtpSender } from './otp-sender';

const TIMEOUT_MS = 8000;

export interface SmsConfig {
  /** Message body. {code} and {app} are replaced. India (DLT) requires this to match an approved template exactly. */
  template: string;
  appName: string;
}

export const DEFAULT_TEMPLATE = 'Your {app} verification code is {code}. It expires in 5 minutes.';

export function renderMessage(cfg: SmsConfig, code: string) {
  return cfg.template.replaceAll('{code}', code).replaceAll('{app}', cfg.appName);
}

/** Shared HTTP call: bounded time, never leaks provider details or the code to the caller. */
async function post(log: Logger, url: string, init: RequestInit): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    log.error(`SMS request failed: ${(e as Error).message}`);
    throw new ServiceUnavailableException('Could not send the code, try again shortly');
  }
  if (!res.ok) {
    // Log status and a short body for the operator; the body can name the number but never contains our code.
    const body = (await res.text().catch(() => '')).slice(0, 300);
    log.error(`SMS provider answered ${res.status}: ${body}`);
    throw new ServiceUnavailableException('Could not send the code, try again shortly');
  }
}

const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

/**
 * Twilio Programmable Messaging (paid). Supply either a sender number (TWILIO_FROM) or a Messaging Service
 * (TWILIO_MESSAGING_SERVICE_SID).
 */
export class TwilioOtpSender extends OtpSender {
  private readonly log = new Logger('Sms.Twilio');

  constructor(
    private readonly o: { accountSid: string; authToken: string; from?: string; messagingServiceSid?: string },
    private readonly cfg: SmsConfig,
  ) {
    super();
    if (!o.from && !o.messagingServiceSid) {
      throw new Error('Twilio needs TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
    }
  }

  async send(phone: string, code: string) {
    const body = new URLSearchParams({ To: phone, Body: renderMessage(this.cfg, code) });
    if (this.o.messagingServiceSid) body.set('MessagingServiceSid', this.o.messagingServiceSid);
    else body.set('From', this.o.from!);
    await post(this.log, `https://api.twilio.com/2010-04-01/Accounts/${this.o.accountSid}/Messages.json`, {
      headers: {
        authorization: basic(this.o.accountSid, this.o.authToken),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  }
}

/**
 * SMSGate (github.com/capcom6/android-sms-gateway, Apache-2.0). An Android phone with a SIM becomes the gateway,
 * so SMS cost is whatever your SIM plan charges. Use the phone's local server URL (same network), the public
 * cloud (https://api.sms-gate.app/3rdparty/v1) or your own private server.
 */
export class SmsGateOtpSender extends OtpSender {
  private readonly log = new Logger('Sms.SmsGate');

  constructor(
    private readonly o: { baseUrl: string; username: string; password: string },
    private readonly cfg: SmsConfig,
  ) {
    super();
  }

  async send(phone: string, code: string) {
    await post(this.log, `${this.o.baseUrl.replace(/\/+$/, '')}/message`, {
      headers: {
        authorization: basic(this.o.username, this.o.password),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        textMessage: { text: renderMessage(this.cfg, code) },
        phoneNumbers: [phone],
      }),
    });
  }
}

/**
 * Generic JSON webhook for any provider or your own bridge (MSG91, Fast2SMS, a Kannel/Jasmin wrapper...).
 * Body is SMS_HTTP_BODY with {phone}, {message} and {code} substituted (values are JSON-escaped).
 */
export class HttpOtpSender extends OtpSender {
  private readonly log = new Logger('Sms.Http');

  constructor(
    private readonly o: { url: string; bodyTemplate: string; headers: Record<string, string> },
    private readonly cfg: SmsConfig,
  ) {
    super();
  }

  async send(phone: string, code: string) {
    const esc = (s: string) => JSON.stringify(s).slice(1, -1);
    const message = renderMessage(this.cfg, code);
    const body = this.o.bodyTemplate
      .replaceAll('{phone}', esc(phone))
      .replaceAll('{message}', esc(message))
      .replaceAll('{code}', esc(code));
    await post(this.log, this.o.url, {
      headers: { 'content-type': 'application/json', ...this.o.headers },
      body,
    });
  }
}

/** Builds the sender named by SMS_PROVIDER. Throws at boot on missing settings rather than at first login. */
export function createOtpSender(env: NodeJS.ProcessEnv, fallback: () => OtpSender): OtpSender {
  const provider = (env.SMS_PROVIDER ?? 'console').toLowerCase();
  const cfg: SmsConfig = {
    template: env.SMS_TEMPLATE ?? DEFAULT_TEMPLATE,
    appName: env.APP_NAME ?? 'Social',
  };
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`SMS_PROVIDER=${provider} requires ${k}`);
    return v;
  };

  switch (provider) {
    case 'console':
      return fallback();
    case 'twilio':
      return new TwilioOtpSender(
        {
          accountSid: need('TWILIO_ACCOUNT_SID'),
          authToken: need('TWILIO_AUTH_TOKEN'),
          from: env.TWILIO_FROM,
          messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
        },
        cfg,
      );
    case 'smsgate':
      return new SmsGateOtpSender(
        { baseUrl: need('SMSGATE_URL'), username: need('SMSGATE_USERNAME'), password: need('SMSGATE_PASSWORD') },
        cfg,
      );
    case 'http': {
      let headers: Record<string, string> = {};
      if (env.SMS_HTTP_HEADERS) headers = JSON.parse(env.SMS_HTTP_HEADERS);
      return new HttpOtpSender(
        {
          url: need('SMS_HTTP_URL'),
          bodyTemplate: env.SMS_HTTP_BODY ?? '{"to":"{phone}","message":"{message}"}',
          headers,
        },
        cfg,
      );
    }
    default:
      throw new Error(`Unknown SMS_PROVIDER "${provider}" (use console, twilio, smsgate or http)`);
  }
}
