import { Logger } from '@nestjs/common';
import { createHmac } from 'crypto';

const DEV_PEPPER = 'dev-contact-pepper-change-me';
let warned = false;

/**
 * Keyed hash of an E.164 phone number, used to match uploaded contacts against accounts without storing
 * either list in a form that can be reversed by brute force (there are only ~10^10 numbers per country).
 * The pepper lives in the environment, not the database, so a database leak alone does not expose numbers.
 */
export function phoneHmac(phone: string, env: NodeJS.ProcessEnv = process.env): string {
  let pepper = env.CONTACT_PEPPER;
  if (!pepper) {
    if (!warned) {
      new Logger('Contacts').warn('CONTACT_PEPPER is not set; using the development pepper');
      warned = true;
    }
    pepper = DEV_PEPPER;
  }
  return createHmac('sha256', pepper).update(phone).digest('hex');
}

export const E164 = /^\+[1-9]\d{7,14}$/;
