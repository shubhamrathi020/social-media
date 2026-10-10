import * as Contacts from 'expo-contacts';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import { api, json } from './api';

/**
 * Turns address-book entries into E.164 numbers. Numbers without a country prefix are read as belonging to the
 * user's own country (taken from their own phone number), which is how people store local contacts.
 */
export function normaliseNumbers(raw: string[], myPhone: string): string[] {
  const home = parsePhoneNumberFromString(myPhone)?.country as CountryCode | undefined;
  const out = new Set<string>();
  for (const r of raw) {
    const n = parsePhoneNumberFromString(r, home);
    if (n?.isValid()) out.add(n.number);
  }
  out.delete(myPhone);
  return [...out];
}

/**
 * Reads the address book (after asking), uploads the numbers over HTTPS and returns how many are on the app.
 * The server turns each number into a keyed hash and discards the number itself.
 */
export async function syncContacts(myPhone: string): Promise<{ uploaded: number; matched: number } | null> {
  const perm = await Contacts.requestPermissionsAsync();
  if (perm.status !== 'granted') return null;
  const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] });
  const raw = data.flatMap((c) => (c.phoneNumbers ?? []).map((p) => p.number ?? '')).filter(Boolean);
  const phones = normaliseNumbers(raw, myPhone).slice(0, 5000);
  return api<{ uploaded: number; matched: number }>('/contacts/sync', json({ phones }));
}

export const forgetContacts = () => api('/contacts', { method: 'DELETE' });
