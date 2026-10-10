import { Injectable, Logger } from '@nestjs/common';

export abstract class OtpSender {
  abstract send(phone: string, code: string): Promise<void>;
}

/** Dev sender: prints the code. Swap for Twilio/Firebase by providing another OtpSender. */
@Injectable()
export class ConsoleOtpSender extends OtpSender {
  private readonly log = new Logger('OTP');

  async send(phone: string, code: string) {
    this.log.warn(`code for ${phone}: ${code}`);
  }
}
