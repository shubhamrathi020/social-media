// End-to-end notifications, push registration, reports and rate limiting.
// Needs the API running with OTP_DEV_CODE=123456 and PUSH_MODE=log (the default outside production).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const sharp = require('sharp');

const HTTP = process.env.API_URL ?? 'http://localhost:3000/v1';
const WS = process.env.WS_URL ?? 'http://localhost:3000';
const CODE = process.env.OTP_DEV_CODE ?? '123456';

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
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}
async function signup(label) {
  const phone = '+1415' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
  await call('POST', '/auth/otp/request', null, { phone });
  const r = await call('POST', '/auth/otp/verify', null, { phone, code: CODE, device: { platform: 'android' } });
  await call('PATCH', '/users/me', r.data.accessToken, { displayName: label });
  return { id: r.data.userId, token: r.data.accessToken, label };
}
async function befriend(a, b) {
  const r = await call('POST', '/friends/requests', a.token, { toUser: b.id });
  await call('POST', `/friends/requests/${r.data.id}/accept`, b.token);
}
async function readyImage(user, purpose) {
  const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#556677' } }).png().toBuffer();
  const up = await call('POST', '/media/uploads', user.token, { kind: 'image', purpose, mime: 'image/png', sizeBytes: png.length });
  await fetch(up.data.upload.url, { method: 'PUT', headers: up.data.upload.headers, body: png });
  await call('POST', `/media/${up.data.id}/complete`, user.token);
  for (let i = 0; i < 60; i++) {
    const m = await call('GET', `/media/${up.data.id}`, user.token);
    if (m.data.status === 'ready') return up.data.id;
    await sleep(250);
  }
  throw new Error('media not ready');
}
const types = (list) => list.map((n) => n.type);

const alice = await signup('alice');
const bob = await signup('bob');
const carol = await signup('carol');

const aliceSock = io(WS, { auth: { token: alice.token }, transports: ['websocket'], reconnection: false });
await new Promise((r) => aliceSock.on('connect', r));
const live = [];
aliceSock.on('notification:new', (n) => live.push(n));

// --- friend request + accept
let r = await call('POST', '/friends/requests', bob.token, { toUser: alice.id });
const reqId = r.data.id;
await sleep(300);
r = await call('GET', '/notifications', alice.token);
check('friend request creates a notification', r.status === 200 && types(r.data.items).includes('friend_request') && r.data.items[0].actor.id === bob.id, JSON.stringify(r.data.items));
check('notification pushed over the socket', live.some((n) => n.type === 'friend_request'));
r = await call('GET', '/notifications/unread-count', alice.token);
check('unread count is 1', r.data.unread === 1, JSON.stringify(r.data));
await call('POST', `/friends/requests/${reqId}/accept`, alice.token);
await sleep(300);
r = await call('GET', '/notifications', bob.token);
check('requester is told it was accepted', types(r.data.items).includes('friend_accepted'));
await befriend(alice, carol);

// --- likes: once per person per post
const mediaId = await readyImage(alice, 'post');
r = await call('POST', '/posts', alice.token, { caption: 'hello', audience: 'friends', mediaIds: [mediaId] });
const post = r.data.id;
await call('PUT', `/posts/${post}/reaction`, bob.token, { value: 1 });
await call('DELETE', `/posts/${post}/reaction`, bob.token);
await call('PUT', `/posts/${post}/reaction`, bob.token, { value: 1 });
await call('PUT', `/posts/${post}/reaction`, alice.token, { value: 1 }); // own like
await call('PUT', `/posts/${post}/reaction`, carol.token, { value: -1 }); // dislike
await sleep(300);
r = await call('GET', '/notifications', alice.token);
const likes = r.data.items.filter((n) => n.type === 'post_liked');
check('toggling a like notifies once', likes.length === 1 && likes[0].actor.id === bob.id && likes[0].entityId === post, JSON.stringify(likes));
check('no notification for own like or a dislike', r.data.items.every((n) => n.actor?.id !== alice.id && n.actor?.id !== carol.id || n.type === 'friend_accepted'));

// --- comments and replies
r = await call('POST', `/posts/${post}/comments`, bob.token, { body: 'great photo' });
const c1 = r.data.id;
await call('POST', `/posts/${post}/comments`, carol.token, { body: 'agree with bob', parentId: c1 });
await sleep(300);
r = await call('GET', '/notifications', alice.token);
check('post author notified of a comment', r.data.items.some((n) => n.type === 'comment' && n.actor.id === bob.id));
check('post author notified of a reply on their post', r.data.items.some((n) => n.type === 'comment' && n.actor.id === carol.id));
r = await call('GET', '/notifications', bob.token);
check('comment author notified of a reply', r.data.items.some((n) => n.type === 'comment_reply' && n.actor.id === carol.id));

// --- preferences
await call('PATCH', '/settings', alice.token, { notifications: { comments: false } });
await call('POST', `/posts/${post}/comments`, bob.token, { body: 'muted by prefs' });
await sleep(300);
r = await call('GET', '/notifications', alice.token);
check('disabled preference suppresses new notifications', !r.data.items.some((n) => n.data?.preview === 'muted by prefs'));
await call('PATCH', '/settings', alice.token, { notifications: { comments: true } });

// --- read state, pagination
r = await call('GET', '/notifications?limit=2', alice.token);
check('pagination returns a cursor', r.data.items.length === 2 && !!r.data.nextCursor);
r = await call('GET', `/notifications?limit=50&cursor=${r.data.nextCursor}`, alice.token);
check('second page is older and non-empty', r.data.items.length > 0);
const first = (await call('GET', '/notifications?limit=1', alice.token)).data.items[0];
r = await call('POST', '/notifications/read', alice.token, { ids: [first.id] });
const before = r.data.unread;
r = await call('POST', '/notifications/read', alice.token, {});
check('mark one then all read', before >= 0 && r.data.unread === 0, JSON.stringify(r.data));
r = await call('POST', '/notifications/read', alice.token, { ids: ['not-a-uuid'] });
check('invalid ids -> 400', r.status === 400);

// --- push token registration
r = await call('PUT', '/devices/me', alice.token, { pushToken: 'not-an-expo-token' });
check('invalid push token -> 400', r.status === 400);
r = await call('PUT', '/devices/me', alice.token, { pushToken: 'ExponentPushToken[abcdefghijklmnop]' });
check('register push token', r.status === 204);
r = await call('PUT', '/devices/me', alice.token, { pushToken: null });
check('clear push token', r.status === 204);

// --- reports
r = await call('POST', '/reports', bob.token, { entityType: 'post', entityId: post, reason: 'spam', details: 'looks fake' });
check('report a visible post', r.status === 201 && r.data.received === true, JSON.stringify(r));
r = await call('POST', '/reports', bob.token, { entityType: 'post', entityId: post, reason: 'hate' });
check('duplicate report is accepted idempotently', r.status === 201 && r.data.id === null);
const stranger = await signup('stranger');
r = await call('POST', '/reports', stranger.token, { entityType: 'post', entityId: post, reason: 'spam' });
check('cannot report a post you cannot see -> 404', r.status === 404);
r = await call('POST', '/reports', bob.token, { entityType: 'user', entityId: bob.id, reason: 'spam' });
check('cannot report yourself -> 400', r.status === 400);
r = await call('POST', '/reports', bob.token, { entityType: 'comment', entityId: c1, reason: 'harassment' });
check('report a comment', r.status === 201);
r = await call('POST', '/reports', bob.token, { entityType: 'user', entityId: carol.id, reason: 'bogus' });
check('invalid reason -> 400', r.status === 400);

// --- security headers + rate limiting
r = await call('GET', '/health');
check('security headers present', r.headers.get('x-content-type-options') === 'nosniff' && !r.headers.get('x-powered-by'));
let limited = null;
for (let i = 0; i < 40 && !limited; i++) {
  const x = await call('POST', '/reports', carol.token, { entityType: 'user', entityId: alice.id, reason: 'spam' });
  if (x.status === 429) limited = x;
}
check('endpoint rate limit is enforced with Retry-After', limited !== null && limited.headers.get('retry-after') !== null);

aliceSock.close();
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
