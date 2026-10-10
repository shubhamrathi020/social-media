// End-to-end chat check over REST + Socket.IO. Needs the API running with OTP_DEV_CODE=123456.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

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
  return { status: res.status, data };
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

/** Socket with an event log and helpers to await specific events. */
function connect(user) {
  const socket = io(WS, { auth: { token: user.token }, transports: ['websocket'], reconnection: false });
  const log = [];
  const waiters = [];
  socket.onAny((event, payload) => {
    log.push({ event, payload });
    for (const w of [...waiters]) {
      if (w.event === event && w.pred(payload)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(payload);
      }
    }
  });
  const waitFor = (event, pred = () => true, ms = 4000) =>
    new Promise((resolve, reject) => {
      const hit = log.find((l) => l.event === event && pred(l.payload));
      if (hit) return resolve(hit.payload);
      const w = { event, pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${event}`)); }
      }, ms);
    });
  const emit = (event, body) => new Promise((resolve) => socket.emit(event, body, resolve));
  const ready = new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
  });
  return { socket, log, waitFor, emit, ready, close: () => socket.close() };
}

const alice = await signup('alice');
const bob = await signup('bob');
const carol = await signup('carol');
const mallory = await signup('mallory');
await befriend(alice, bob);
await befriend(alice, carol);
await befriend(bob, carol);

// --- socket auth
const bad = io(WS, { auth: { token: 'nope' }, transports: ['websocket'], reconnection: false });
const rejected = await new Promise((res) => { bad.on('connect_error', () => res(true)); bad.on('connect', () => res(false)); });
bad.close();
check('socket rejects bad token', rejected === true);

const A = connect(alice);
const B = connect(bob);
await Promise.all([A.ready, B.ready]);

// --- presence: bob comes online, alice (friend) hears about it; present from the start for late joiners
const pres = await A.emit('presence:get', { userIds: [bob.id, mallory.id] });
check('presence visible for friend, hidden for stranger', pres.ok && pres.data[bob.id]?.online === true && !(mallory.id in pres.data), JSON.stringify(pres));

// --- conversations
let r = await call('POST', '/conversations', alice.token, { userId: bob.id });
check('open direct chat', r.status === 201 && r.data.type === 'direct' && r.data.members.length === 2, JSON.stringify(r));
const conv = r.data.id;
r = await call('POST', '/conversations', bob.token, { userId: alice.id });
check('same direct chat from the other side', r.data.id === conv);
r = await call('POST', '/conversations', mallory.token, { userId: alice.id });
check('stranger cannot start chat (privacy=friends) -> 403', r.status === 403, JSON.stringify(r));

// --- send via socket, receive on the other, idempotency
const clientMsgId = randomUUID();
const incoming = B.waitFor('message:new');
let sent = await A.emit('message:send', { conversationId: conv, clientMsgId, type: 'text', payload: { text: 'hello bob' } });
check('send acked', sent.ok && sent.data.message.status === 'sent' && sent.data.duplicate === false, JSON.stringify(sent));
const got = await incoming.catch((e) => ({ error: e.message }));
check('bob receives message:new', got.payload?.text === 'hello bob' && got.senderId === alice.id, JSON.stringify(got));
const msgId = sent.data.message.id;

const again = await A.emit('message:send', { conversationId: conv, clientMsgId, type: 'text', payload: { text: 'hello bob' } });
check('resend with same clientMsgId is idempotent', again.ok && again.data.duplicate === true && again.data.message.id === msgId);
await sleep(150);
check('no duplicate delivery to bob', B.log.filter((l) => l.event === 'message:new').length === 1);

// --- validation errors come back as acks
let bad1 = await A.emit('message:send', { conversationId: conv, clientMsgId: 'short', type: 'text', payload: { text: 'x' } });
check('invalid payload -> ack error 400', bad1.ok === false && bad1.error.code === 400, JSON.stringify(bad1));
bad1 = await A.emit('message:send', { conversationId: randomUUID(), clientMsgId: randomUUID(), type: 'text', payload: { text: 'x' } });
check('unknown conversation -> 404', bad1.ok === false && bad1.error.code === 404, JSON.stringify(bad1));
const C = connect(carol); await C.ready;
bad1 = await C.emit('message:send', { conversationId: conv, clientMsgId: randomUUID(), type: 'text', payload: { text: 'sneaky' } });
check('non-member cannot send -> 404', bad1.ok === false && bad1.error.code === 404);
check('non-member got nothing', !C.log.some((l) => l.event === 'message:new'));

// --- delivered + read receipts reach the sender
const delivered = A.waitFor('message:status', (p) => p.messageId === msgId && p.status === 'delivered');
await B.emit('message:delivered', { messageIds: [msgId] });
check('sender sees delivered', !!(await delivered.catch(() => null)));
const readEvt = A.waitFor('conversation:read', (p) => p.userId === bob.id);
await B.emit('message:read', { conversationId: conv, upToMessageId: msgId });
check('sender sees read', (await readEvt.catch(() => null))?.upToMessageId === msgId);
r = await call('GET', `/conversations/${conv}/messages`, alice.token);
check('history status = read for sender', r.data[0].id === msgId && r.data[0].status === 'read', JSON.stringify(r.data[0]));

// --- typing
const typing = A.waitFor('typing', (p) => p.isTyping === true && p.userId === bob.id);
await B.emit('typing:start', { conversationId: conv });
check('typing indicator delivered', !!(await typing.catch(() => null)));

// --- unread counts + history pagination
for (let i = 0; i < 3; i++) {
  await B.emit('message:send', { conversationId: conv, clientMsgId: randomUUID(), type: 'text', payload: { text: `m${i}` } });
}
r = await call('GET', '/conversations', alice.token);
check('unread count = 3', r.data[0].unread === 3 && r.data[0].lastMessage.payload.text === 'm2', JSON.stringify(r.data[0]));
r = await call('GET', `/conversations/${conv}/messages?limit=2`, alice.token);
check('history newest first, page of 2', r.data.length === 2 && r.data[0].payload.text === 'm2');
const oldest = r.data[1].id;
r = await call('GET', `/conversations/${conv}/messages?limit=10&before=${oldest}`, alice.token);
check('history pagination with before', r.data.length === 2 && r.data[0].payload.text === 'm0');

// --- offline sync: carol-less. alice "offline" fetches everything after a cursor
r = await call('GET', `/chat/sync?after=${msgId}`, alice.token);
check('sync returns messages after cursor', r.data.length === 3 && r.data[0].payload.text === 'm0', JSON.stringify(r.data.length));

// --- media message
const png = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#222' } }).png().toBuffer();
const up = await call('POST', '/media/uploads', alice.token, { kind: 'image', purpose: 'chat', mime: 'image/png', sizeBytes: png.length });
await fetch(up.data.upload.url, { method: 'PUT', headers: up.data.upload.headers, body: png });
await call('POST', `/media/${up.data.id}/complete`, alice.token);
for (let i = 0; i < 40; i++) {
  const m = await call('GET', `/media/${up.data.id}`, alice.token);
  if (m.data.status === 'ready') break;
  await sleep(300);
}
const mediaIncoming = B.waitFor('message:new', (p) => p.type === 'image');
sent = await A.emit('message:send', { conversationId: conv, clientMsgId: randomUUID(), type: 'image', payload: { mediaId: up.data.id, caption: 'look' } });
const mm = await mediaIncoming.catch(() => null);
check('image message delivered with signed url', sent.ok && mm?.media?.url && mm.payload.caption === 'look', JSON.stringify(sent));
sent = await A.emit('message:send', { conversationId: conv, clientMsgId: randomUUID(), type: 'video', payload: { mediaId: up.data.id } });
check('media kind mismatch rejected', sent.ok === false && sent.error.code === 400, JSON.stringify(sent));
const foreign = await call('POST', '/media/uploads', bob.token, { kind: 'image', purpose: 'chat', mime: 'image/png', sizeBytes: png.length });
sent = await A.emit('message:send', { conversationId: conv, clientMsgId: randomUUID(), type: 'image', payload: { mediaId: foreign.data.id } });
check("someone else's / unfinished media rejected", sent.ok === false && sent.error.code === 400);

// --- delete for me / everyone
const delEvt = B.waitFor('message:deleted', (p) => p.messageId === msgId);
r = await call('DELETE', `/messages/${msgId}?scope=everyone`, alice.token);
check('delete for everyone', r.status === 204 && !!(await delEvt.catch(() => null)));
r = await call('GET', `/conversations/${conv}/messages?limit=50`, bob.token);
const tomb = r.data.find((m) => m.id === msgId);
check('tombstone has no content', tomb?.deleted === true && !tomb.payload.text);
r = await call('DELETE', `/messages/${msgId}?scope=everyone`, bob.token);
check("cannot delete someone else's for everyone -> 403", r.status === 403);
const bobsMsg = (await call('GET', `/conversations/${conv}/messages?limit=1`, alice.token)).data;
r = await call('DELETE', `/messages/${bobsMsg[0].id}?scope=me`, alice.token);
const after = await call('GET', `/conversations/${conv}/messages?limit=50`, alice.token);
check('delete for me hides only for me', r.status === 204 && !after.data.some((m) => m.id === bobsMsg[0].id));
const bobView = await call('GET', `/conversations/${conv}/messages?limit=50`, bob.token);
check('still visible for the other user', bobView.data.some((m) => m.id === bobsMsg[0].id));

// --- group chat
r = await call('POST', '/conversations', alice.token, { title: 'trio', memberIds: [bob.id, carol.id] });
check('create group', r.status === 201 && r.data.type === 'group' && r.data.members.length === 3, JSON.stringify(r));
const group = r.data.id;
const gB = B.waitFor('message:new', (p) => p.conversationId === group);
const gC = C.waitFor('message:new', (p) => p.conversationId === group);
await A.emit('message:send', { conversationId: group, clientMsgId: randomUUID(), type: 'text', payload: { text: 'hi all' } });
const both = await Promise.all([gB.catch(() => null), gC.catch(() => null)]);
check('group message reaches all members', both.every((m) => m?.payload?.text === 'hi all'));
r = await call('POST', '/conversations', alice.token, { title: 'x', memberIds: [mallory.id, bob.id] });
check('group rejects non-friends -> 400', r.status === 400);

// --- block stops messaging in an existing chat
await call('PUT', `/blocks/${alice.id}`, bob.token);
sent = await A.emit('message:send', { conversationId: conv, clientMsgId: randomUUID(), type: 'text', payload: { text: 'after block' } });
check('blocked user cannot message in existing chat -> 403', sent.ok === false && sent.error.code === 403, JSON.stringify(sent));
await call('DELETE', `/blocks/${alice.id}`, bob.token);

// --- offline presence + last seen
// (alice is no longer bob's friend after the block above, so carol is the observer)
const off = C.waitFor('presence', (p) => p.userId === bob.id && p.online === false);
B.close();
const offEvt = await off.catch(() => null);
check('friend sees bob go offline with lastSeen', offEvt?.online === false && !!offEvt.lastSeenAt, JSON.stringify(offEvt));

A.close(); C.close();
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
