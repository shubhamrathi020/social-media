// End-to-end encryption check, playing real clients with the shared crypto module.
// Needs the API running with OTP_DEV_CODE=123456 and DATABASE_URL reachable (to inspect what the server stores).
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const sharp = require('sharp');
const { Client } = require('pg');
const e2e = require('@social/shared');

const HTTP = process.env.API_URL ?? 'http://localhost:3000/v1';
const WS = process.env.WS_URL ?? 'http://localhost:3000';
const CODE = process.env.OTP_DEV_CODE ?? '123456';
const DB = process.env.DATABASE_URL ?? 'postgresql://social:social@localhost:5433/social';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, token, body) {
  const res = await fetch(HTTP + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const newPhone = () => '+1415' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');

/** Signs in (a new device each time) and, unless keyless, registers a fresh device key like the app does. */
async function device(phone, label, { keyless = false } = {}) {
  await call('POST', '/auth/otp/request', null, { phone });
  const r = await call('POST', '/auth/otp/verify', null, { phone, code: CODE, device: { platform: 'android' } });
  if (label) await call('PATCH', '/users/me', r.data.accessToken, { displayName: label });
  const d = { phone, userId: r.data.userId, token: r.data.accessToken, keys: null, deviceId: null };
  if (!keyless) {
    d.keys = e2e.generateDeviceKeys();
    const k = await call('PUT', '/devices/me/keys', d.token, { identityKey: d.keys.publicKey });
    d.deviceId = k.data?.deviceId;
  }
  return d;
}
async function befriend(a, b) {
  const r = await call('POST', '/friends/requests', a.token, { toUser: b.userId });
  await call('POST', `/friends/requests/${r.data.id}/accept`, b.token);
}
const devicesOf = async (d, conv) => (await call('GET', `/conversations/${conv}/devices`, d.token)).data;
async function sendEncrypted(from, conv, payload, { recipients, type = 'text', attachmentId } = {}) {
  const list = recipients ?? (await devicesOf(from, conv));
  const encrypted = e2e.encryptMessage(payload, from.keys, list);
  return call('POST', `/conversations/${conv}/messages`, from.token, { clientMsgId: randomUUID(), type, encrypted, attachmentId });
}
const open = (msg, d) => {
  const env = msg.encrypted?.keys?.[d.deviceId];
  return env ? e2e.decryptMessage(msg.encrypted.ciphertext, env, msg.encrypted.senderKey, d.keys) : null;
};

const alicePhone = newPhone();
const alice = await device(alicePhone, 'alice');
const bob = await device(newPhone(), 'bob');
const dave = await device(newPhone(), 'dave');
const carol = await device(newPhone(), 'carol', { keyless: true }); // an older app without encryption
await befriend(alice, bob);
await befriend(alice, carol);
await befriend(alice, dave);
await befriend(bob, dave);

check('devices register their public keys', !!alice.deviceId && !!bob.deviceId);
let r = await call('PUT', '/devices/me/keys', alice.token, { identityKey: alice.keys.publicKey });
check('re-registering the same key is fine', r.status === 200);
r = await call('PUT', '/devices/me/keys', alice.token, { identityKey: e2e.generateDeviceKeys().publicKey });
check('a device key cannot be swapped -> 409', r.status === 409);
r = await call('PUT', '/devices/me/keys', bob.token, { identityKey: 'too-short' });
check('malformed key -> 400', r.status === 400);

// --- conversations become encrypted only when everyone can decrypt
r = await call('POST', '/conversations', alice.token, { userId: bob.userId });
const conv = r.data.id;
check('chat between key-holding users is end-to-end encrypted', r.data.e2e === true, JSON.stringify(r.data));
r = await call('POST', '/conversations', alice.token, { userId: carol.userId });
check('chat with someone on an old app is not', r.data.e2e === false);
check('recipients list = every device in the chat', (await devicesOf(alice, conv)).length === 2);

// --- server-side enforcement
r = await call('POST', `/conversations/${conv}/messages`, alice.token, { clientMsgId: randomUUID(), type: 'text', payload: { text: 'plain' } });
check('plaintext is refused in an encrypted chat -> 400', r.status === 400);
r = await sendEncrypted(alice, conv, { text: 'x' }, { recipients: [{ deviceId: alice.deviceId, identityKey: alice.keys.publicKey }] });
check('leaving out a device is refused -> 409 with the current list', r.status === 409 && r.data.code === 'DEVICES_CHANGED' && r.data.devices.length === 2, JSON.stringify(r.data));

// --- real-time delivery and decryption
const bobSock = io(WS, { auth: { token: bob.token }, transports: ['websocket'], reconnection: false });
await new Promise((res) => bobSock.on('connect', res));
const live = new Promise((res) => bobSock.once('message:new', res));
const secretText = 'meet at the old gate at 9 🔐';
r = await sendEncrypted(alice, conv, { text: secretText });
check('encrypted send accepted', r.status === 201 && r.data.encrypted?.ciphertext, JSON.stringify(r.data).slice(0, 200));
const msg1 = r.data;
const pushed = await Promise.race([live, sleep(3000).then(() => null)]);
check('recipient decrypts the live message', pushed && open(pushed, bob)?.text === secretText);
check('the server-side view carries no plaintext', JSON.stringify(pushed).indexOf('old gate') === -1);
check('sender identity is authenticated', pushed?.encrypted.senderDeviceId === alice.deviceId && pushed.encrypted.senderKey === alice.keys.publicKey);

const pg = new Client({ connectionString: DB });
await pg.connect();
const stored = await pg.query('SELECT payload, enc_version FROM messages WHERE id = $1', [msg1.id]);
check('database holds only ciphertext', stored.rows[0].enc_version === 1 && !stored.rows[0].payload.includes(Buffer.from('old gate')));

r = await call('GET', `/conversations/${conv}/messages`, bob.token);
const hist = r.data.find((m) => m.id === msg1.id);
check('history returns only this device\'s envelope', Object.keys(hist.encrypted.keys).join() === bob.deviceId);
check('history decrypts', open(hist, bob)?.text === secretText);

// --- a second device for alice
await sleep(31_000); // resend cooldown for this phone number
const alice2 = await device(alicePhone, null);
check('second device has its own key', alice2.deviceId && alice2.deviceId !== alice.deviceId);
r = await sendEncrypted(alice, conv, { text: 'stale list' }, { recipients: [{ deviceId: alice.deviceId, identityKey: alice.keys.publicKey }, { deviceId: bob.deviceId, identityKey: bob.keys.publicKey }] });
check('a new device in the chat forces re-encryption -> 409', r.status === 409 && r.data.devices.length === 3);
r = await sendEncrypted(bob, conv, { text: 'hi both of your phones' });
const msg2 = r.data;
const onA2 = (await call('GET', `/conversations/${conv}/messages`, alice2.token)).data;
check('new device reads messages sent after it joined', open(onA2.find((m) => m.id === msg2.id), alice2)?.text === 'hi both of your phones');
check('...but not older ones (no key was ever sealed for it)', open(onA2.find((m) => m.id === msg1.id), alice2) === null);
const onA1 = (await call('GET', `/conversations/${conv}/messages`, alice.token)).data;
check("sender's other devices can read what it sent", open(onA1.find((m) => m.id === msg2.id), alice)?.text === 'hi both of your phones');

// --- encrypted attachment
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ff8800' } }).png().toBuffer();
const sealed = e2e.encryptFile(new Uint8Array(png));
const up = await call('POST', '/media/uploads', alice.token, { kind: 'file', purpose: 'chat', mime: 'application/octet-stream', sizeBytes: sealed.data.length });
await fetch(up.data.upload.url, { method: 'PUT', headers: up.data.upload.headers, body: Buffer.from(sealed.data) });
await call('POST', `/media/${up.data.id}/complete`, alice.token);
for (let i = 0; i < 40; i++) {
  if ((await call('GET', `/media/${up.data.id}`, alice.token)).data.status === 'ready') break;
  await sleep(250);
}
r = await sendEncrypted(alice, conv, { kind: 'image', mime: 'image/png', fileKey: sealed.fileKey, fileNonce: sealed.fileNonce, width: 64, height: 64 }, { type: 'image', attachmentId: up.data.id });
check('encrypted attachment message accepted', r.status === 201, JSON.stringify(r.data));
const att = (await call('GET', `/conversations/${conv}/messages?limit=1`, bob.token)).data[0];
const attPayload = open(att, bob);
const blob = new Uint8Array(await (await fetch(att.media.url)).arrayBuffer());
check('stored file is opaque to the server', !Buffer.from(blob).includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
const plainFile = e2e.decryptFile(blob, attPayload.fileKey, attPayload.fileNonce);
check('recipient decrypts the attachment byte-for-byte', plainFile && Buffer.from(plainFile).equals(png));

// --- groups
r = await call('POST', '/conversations', alice.token, { title: 'secret club', memberIds: [bob.userId, dave.userId] });
const group = r.data.id;
check('group of key-holders is encrypted', r.data.e2e === true);
r = await sendEncrypted(dave, group, { text: 'group secret' });
const gm = (await call('GET', `/conversations/${group}/messages`, bob.token)).data[0];
check('group members decrypt', open(gm, bob)?.text === 'group secret');
r = await call('POST', `/conversations/${group}/members`, alice.token, { userIds: [carol.userId] });
check('cannot add someone without keys to an encrypted group -> 400', r.status === 400, JSON.stringify(r.data));

// --- story replies cannot be written by the server into an encrypted chat
const storyPng = await sharp({ create: { width: 90, height: 160, channels: 3, background: '#335577' } }).png().toBuffer();
const sUp = await call('POST', '/media/uploads', bob.token, { kind: 'image', purpose: 'story', mime: 'image/png', sizeBytes: storyPng.length });
await fetch(sUp.data.upload.url, { method: 'PUT', headers: sUp.data.upload.headers, body: storyPng });
await call('POST', `/media/${sUp.data.id}/complete`, bob.token);
for (let i = 0; i < 40; i++) {
  if ((await call('GET', `/media/${sUp.data.id}`, bob.token)).data.status === 'ready') break;
  await sleep(300);
}
const story = (await call('POST', '/stories', bob.token, { mediaId: sUp.data.id })).data;
r = await call('POST', `/stories/${story.id}/reply`, alice.token, { text: 'nice' });
check('story reply into an encrypted chat is handed back to the app -> 409', r.status === 409 && r.data.code === 'E2E_CONVERSATION' && r.data.conversationId === conv, JSON.stringify(r.data));

// --- safety numbers
const bobKeys = (await call('GET', `/users/${bob.userId}/device-keys`, alice.token)).data.map((k) => k.identityKey);
const aliceKeys = (await call('GET', `/users/${alice.userId}/device-keys`, bob.token)).data.map((k) => k.identityKey);
const onAlice = e2e.safetyNumber({ userId: alice.userId, keys: [alice.keys.publicKey, alice2.keys.publicKey] }, { userId: bob.userId, keys: bobKeys });
const onBob = e2e.safetyNumber({ userId: bob.userId, keys: [bob.keys.publicKey] }, { userId: alice.userId, keys: aliceKeys });
check('safety numbers match on both phones', onAlice === onBob, `${onAlice} vs ${onBob}`);

// --- delete for everyone removes the envelopes too
await call('DELETE', `/messages/${msg1.id}?scope=everyone`, alice.token);
const keysLeft = await pg.query('SELECT count(*)::int AS n FROM message_keys WHERE message_id = $1', [msg1.id]);
check('deleting a message deletes its sealed keys', keysLeft.rows[0].n === 0);

// --- logging a device out removes it from future recipients
await call('POST', '/auth/logout', alice2.token);
check('logged-out device is no longer a recipient', (await devicesOf(alice, conv)).length === 2);

await pg.end();
bobSock.close();
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
