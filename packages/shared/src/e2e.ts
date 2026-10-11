/**
 * End-to-end encryption for chat (protocol version 1). Used by the app and by the API's end-to-end tests; the
 * server itself never encrypts or decrypts. See docs/E2E.md for the design and its limits.
 *
 * Primitives come from TweetNaCl (audited): X25519 + XSalsa20-Poly1305 (`box`, `secretbox`) and SHA-512.
 *
 *   message:   key = random(32), nonce = random(24), ciphertext = secretbox(utf8(json(payload)), nonce, key)
 *   envelope:  for every recipient device d: box(key, nonce_d, d.publicKey, sender.secretKey)
 *
 * Every device (including the sender's other devices and the sending device itself) gets its own envelope, so
 * each can decrypt independently. Envelopes are authenticated with the sender device's key, so a recipient also
 * learns which device sent the message.
 */
import nacl from 'tweetnacl';

export const E2E_VERSION = 1;

export interface DeviceKeyPair {
  publicKey: string; // base64
  secretKey: string; // base64, never leaves the device
}

export interface RecipientDevice {
  deviceId: string;
  identityKey: string; // base64 public key
}

export interface EncryptedMessage {
  /** base64(nonce || secretbox ciphertext) */
  ciphertext: string;
  /** one sealed copy of the message key per device */
  keys: { deviceId: string; box: string }[];
}

// ---- encoding helpers (no Buffer: must run in React Native) -------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((B64.indexOf(clean[i + 2]) & 63) << 6) |
      (B64.indexOf(clean[i + 3]) & 63);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.slice(0, o);
}

const utf8 = {
  encode: (s: string) => new TextEncoder().encode(s),
  decode: (b: Uint8Array) => new TextDecoder().decode(b),
};

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** React Native has no crypto.getRandomValues by default; the app installs a secure source at startup. */
export function setRandomSource(fill: (n: number) => Uint8Array) {
  nacl.setPRNG((x: Uint8Array, n: number) => x.set(fill(n)));
}

// ---- keys ------------------------------------------------------------------------------------------

export function generateDeviceKeys(): DeviceKeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: toBase64(kp.publicKey), secretKey: toBase64(kp.secretKey) };
}

export const isValidPublicKey = (k: string) => {
  try {
    return fromBase64(k).length === nacl.box.publicKeyLength;
  } catch {
    return false;
  }
};

// ---- messages --------------------------------------------------------------------------------------

export function encryptMessage(
  payload: unknown,
  sender: DeviceKeyPair,
  recipients: RecipientDevice[],
): EncryptedMessage {
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const body = nacl.secretbox(utf8.encode(JSON.stringify(payload)), nonce, key);
  const secret = fromBase64(sender.secretKey);
  return {
    ciphertext: toBase64(concat(nonce, body)),
    keys: recipients.map((d) => {
      const n = nacl.randomBytes(nacl.box.nonceLength);
      return { deviceId: d.deviceId, box: toBase64(concat(n, nacl.box(key, n, fromBase64(d.identityKey), secret))) };
    }),
  };
}

/**
 * Returns the payload, or null when the envelope or ciphertext fails authentication (tampered, or not
 * actually from the claimed sender device).
 */
export function decryptMessage<T = unknown>(
  ciphertext: string,
  envelope: string,
  senderIdentityKey: string,
  me: DeviceKeyPair,
): T | null {
  try {
    const env = fromBase64(envelope);
    const key = nacl.box.open(
      env.slice(nacl.box.nonceLength),
      env.slice(0, nacl.box.nonceLength),
      fromBase64(senderIdentityKey),
      fromBase64(me.secretKey),
    );
    if (!key) return null;
    const ct = fromBase64(ciphertext);
    const plain = nacl.secretbox.open(ct.slice(nacl.secretbox.nonceLength), ct.slice(0, nacl.secretbox.nonceLength), key);
    return plain ? (JSON.parse(utf8.decode(plain)) as T) : null;
  } catch {
    return null;
  }
}

// ---- attachments -----------------------------------------------------------------------------------

/** Encrypts file bytes before upload; key and nonce travel inside the (encrypted) message payload. */
export function encryptFile(bytes: Uint8Array) {
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { data: nacl.secretbox(bytes, nonce, key), fileKey: toBase64(key), fileNonce: toBase64(nonce) };
}

export function decryptFile(data: Uint8Array, fileKey: string, fileNonce: string): Uint8Array | null {
  return nacl.secretbox.open(data, fromBase64(fileNonce), fromBase64(fileKey));
}

// ---- safety numbers --------------------------------------------------------------------------------

/**
 * A 60-digit code two people compare (in person or on a call). It is derived from both people's device keys, so
 * if the server ever substituted a key, the codes on the two phones would differ. Same on both sides.
 */
export function safetyNumber(a: { userId: string; keys: string[] }, b: { userId: string; keys: string[] }): string {
  const side = (x: { userId: string; keys: string[] }) => `${x.userId}:${[...x.keys].sort().join(',')}`;
  const [first, second] = [side(a), side(b)].sort();
  let digest = nacl.hash(utf8.encode(`v1|${first}|${second}`));
  for (let i = 0; i < 1024; i++) digest = nacl.hash(digest); // slows brute-force of near-collisions
  let digits = '';
  for (let i = 0; digits.length < 60; i += 5) {
    const n = ((digest[i] << 24) | (digest[i + 1] << 16) | (digest[i + 2] << 8) | digest[i + 3]) >>> 0;
    digits += String(n % 100000).padStart(5, '0');
  }
  return digits.match(/.{5}/g)!.join(' ');
}
