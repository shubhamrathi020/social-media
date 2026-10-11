import * as Crypto from 'expo-crypto';
import {
  DeviceKeyPair,
  RecipientDevice,
  decryptFile,
  decryptMessage,
  encryptFile,
  encryptMessage,
  generateDeviceKeys,
  safetyNumber,
  setRandomSource,
  toBase64,
} from '@social/shared';
import { api } from '../lib/api';
import { storage } from '../lib/storage';
import { emitAck } from './socket';
import { ChatMessage } from './types';

// tweetnacl needs a secure random source; React Native has no crypto.getRandomValues by default.
setRandomSource((n) => Crypto.getRandomBytes(n));

/**
 * This install's device keys. The private half never leaves the phone (secure storage); the public half is
 * registered with the server for every new sign-in. One key pair per account per install.
 */
let device: (DeviceKeyPair & { deviceId: string; userId: string }) | null = null;

const keyName = (userId: string) => `e2e.keys.${userId}`;

export async function ensureDeviceKeys(userId: string) {
  let keys: DeviceKeyPair | null = null;
  try {
    const saved = await storage.get(keyName(userId));
    keys = saved ? (JSON.parse(saved) as DeviceKeyPair) : null;
  } catch {
    keys = null;
  }
  if (!keys) {
    keys = generateDeviceKeys();
    await storage.set(keyName(userId), JSON.stringify(keys));
  }
  const r = await api<{ deviceId: string }>('/devices/me/keys', {
    method: 'PUT',
    body: JSON.stringify({ identityKey: keys.publicKey }),
  });
  device = { ...keys, deviceId: r.deviceId, userId };
}

export const forgetDeviceKeysInMemory = () => {
  device = null;
};

/** Decrypts in place. Messages this device has no key for (sent before it signed in) are marked as such. */
export function decryptIncoming(m: ChatMessage): ChatMessage {
  if (!m.encrypted || m.deleted) return m;
  const envelope = device ? m.encrypted.keys[device.deviceId] : undefined;
  if (!device || !envelope || !m.encrypted.senderKey) return { ...m, payload: {}, undecryptable: true };
  const payload = decryptMessage<ChatMessage['payload']>(m.encrypted.ciphertext, envelope, m.encrypted.senderKey, device);
  return payload ? { ...m, payload, undecryptable: false } : { ...m, payload: {}, undecryptable: true };
}

// ---- sending -------------------------------------------------------------------------------------

const recipients = new Map<string, RecipientDevice[]>();

async function devicesFor(conversationId: string, refresh = false) {
  if (refresh || !recipients.has(conversationId)) {
    recipients.set(conversationId, await api<RecipientDevice[]>(`/conversations/${conversationId}/devices`));
  }
  return recipients.get(conversationId)!;
}

/**
 * Encrypts for every current device in the conversation and sends over the socket. If the server says the device
 * list changed (someone signed in on a new phone), fetch the new list and encrypt again once.
 */
export async function sendEncrypted(
  input: { conversationId: string; clientMsgId: string; type: ChatMessage['type']; payload: ChatMessage['payload']; attachmentId?: string },
) {
  if (!device) throw new Error('Encryption keys are not ready yet');
  for (let attempt = 0; attempt < 2; attempt++) {
    const list = await devicesFor(input.conversationId, attempt > 0);
    const encrypted = encryptMessage(input.payload, device, list);
    const res = await emitAck<{ message: ChatMessage }>('message:send', {
      conversationId: input.conversationId,
      clientMsgId: input.clientMsgId,
      type: input.type,
      encrypted,
      attachmentId: input.attachmentId,
    });
    if (res.ok) return { ...res, data: { message: decryptIncoming(res.data.message) } };
    if (res.error.code !== 409) return res;
  }
  return { ok: false as const, error: { code: 409, message: 'The people in this chat changed; try again' } };
}

/** Encrypts the file on the phone and uploads the opaque blob; the key travels inside the encrypted message. */
export async function uploadEncryptedFile(uri: string) {
  const bytes = new Uint8Array(await (await fetch(uri)).arrayBuffer());
  const sealed = encryptFile(bytes);
  const ticket = await api<{ id: string; upload: { url: string; headers: Record<string, string> } }>('/media/uploads', {
    method: 'POST',
    body: JSON.stringify({ kind: 'file', purpose: 'chat', mime: 'application/octet-stream', sizeBytes: sealed.data.length }),
  });
  const put = await fetch(ticket.upload.url, { method: 'PUT', headers: ticket.upload.headers, body: sealed.data as unknown as BodyInit });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  await api(`/media/${ticket.id}/complete`, { method: 'POST' });
  return { attachmentId: ticket.id, fileKey: sealed.fileKey, fileNonce: sealed.fileNonce };
}

const fileCache = new Map<string, string>();

/** Downloads and decrypts an attachment into a data: URI (kept in memory for the session). */
export async function decryptAttachment(m: ChatMessage): Promise<string | null> {
  const p = m.payload;
  if (!m.media?.url || !p.fileKey || !p.fileNonce) return null;
  const cached = fileCache.get(m.id);
  if (cached) return cached;
  const data = new Uint8Array(await (await fetch(m.media.url)).arrayBuffer());
  const plain = decryptFile(data, p.fileKey, p.fileNonce);
  if (!plain) return null;
  const uri = `data:${p.mime ?? 'application/octet-stream'};base64,${toBase64(plain)}`;
  fileCache.set(m.id, uri);
  return uri;
}

// ---- verification --------------------------------------------------------------------------------

/** The 60-digit code both people should see; compare it in person or on a call. */
export async function safetyNumberWith(meId: string, otherId: string) {
  const keys = (id: string) => api<{ identityKey: string }[]>(`/users/${id}/device-keys`).then((l) => l.map((k) => k.identityKey));
  const [mine, theirs] = await Promise.all([keys(meId), keys(otherId)]);
  if (!mine.length || !theirs.length) return null;
  return safetyNumber({ userId: meId, keys: mine }, { userId: otherId, keys: theirs });
}
