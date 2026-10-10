import { Injectable, Logger } from '@nestjs/common';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export abstract class PushSender {
  /** Returns tokens the push service reported as no longer valid, so they can be forgotten. */
  abstract send(messages: PushMessage[]): Promise<{ invalidTokens: string[] }>;
}

/** Development sender: writes what would have been pushed to the log. */
@Injectable()
export class LogPushSender extends PushSender {
  private readonly log = new Logger('Push');
  readonly sent: PushMessage[] = [];

  async send(messages: PushMessage[]) {
    for (const m of messages) {
      this.sent.push(m);
      if (this.sent.length > 200) this.sent.shift();
      this.log.log(`-> ${m.to.slice(0, 24)}… "${m.title}": ${m.body}`);
    }
    return { invalidTokens: [] };
  }
}

/** Sends through the Expo push service (works for both iOS and Android Expo push tokens). */
@Injectable()
export class ExpoPushSender extends PushSender {
  private readonly log = new Logger('Push');

  async send(messages: PushMessage[]) {
    const invalidTokens: string[] = [];
    // Expo accepts up to 100 messages per request.
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      try {
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(batch.map((m) => ({ ...m, sound: 'default' }))),
        });
        if (!res.ok) {
          this.log.warn(`expo push responded ${res.status}`);
          continue;
        }
        const body = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
        body.data?.forEach((ticket, idx) => {
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            invalidTokens.push(batch[idx].to);
          }
        });
      } catch (e) {
        this.log.warn(`expo push failed: ${(e as Error).message}`);
      }
    }
    return { invalidTokens };
  }
}
