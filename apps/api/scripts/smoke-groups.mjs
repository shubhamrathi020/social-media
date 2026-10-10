// End-to-end group administration check. Needs the API running with OTP_DEV_CODE=123456.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');

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
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
const say = (u, conv, text) =>
  call('POST', `/conversations/${conv}/messages`, u.token, { clientMsgId: randomUUID(), type: 'text', payload: { text } });

const [ann, ben, cat, dan, eve] = await Promise.all(['ann', 'ben', 'cat', 'dan', 'eve'].map(signup));
for (const x of [ben, cat, dan]) await befriend(ann, x);
await befriend(ben, eve);

let r = await call('POST', '/conversations', ann.token, { title: 'Trip', memberIds: [ben.id, cat.id] });
const g = r.data.id;
check('creator is admin', r.data.myRole === 'admin');

const danSock = io(WS, { auth: { token: dan.token }, transports: ['websocket'], reconnection: false });
await new Promise((res) => danSock.on('connect', res));
const danEvents = [];
danSock.onAny((e, p) => danEvents.push({ e, p }));

await say(ann, g, 'before dan joined');

// --- permissions
r = await call('POST', `/conversations/${g}/members`, ben.token, { userIds: [eve.id] });
check('non-admin cannot add -> 403', r.status === 403);
r = await call('POST', `/conversations/${g}/members`, ann.token, { userIds: [eve.id] });
check('cannot add someone who is not your friend -> 400', r.status === 400);
r = await call('PATCH', `/conversations/${g}`, ben.token, { title: 'Hijacked' });
check('non-admin cannot rename -> 403', r.status === 403);

// --- add + history from join
r = await call('POST', `/conversations/${g}/members`, ann.token, { userIds: [dan.id] });
check('admin adds a friend', r.status === 201 && r.data.members.length === 4, JSON.stringify(r.data?.members?.length));
await sleep(300);
check('added member is told about the new conversation', danEvents.some((x) => x.e === 'conversation:new' && x.p.conversationId === g));
r = await call('GET', `/conversations/${g}/messages?limit=50`, dan.token);
check('new member does not see older messages', !r.data.some((m) => m.payload.text === 'before dan joined'), JSON.stringify(r.data.map((m) => m.payload)));
check('a system notice records who was added', r.data.some((m) => m.type === 'system' && m.payload.event === 'members_added' && m.payload.userIds.includes(dan.id)));
r = await call('GET', '/conversations', dan.token);
check('system notices do not count as unread', r.data.find((c) => c.id === g)?.unread === 0, JSON.stringify(r.data.find((c) => c.id === g)));
await say(ben, g, 'hello dan');
r = await call('GET', '/conversations', dan.token);
check('real messages after joining are unread', r.data.find((c) => c.id === g)?.unread === 1);

// --- rename
r = await call('PATCH', `/conversations/${g}`, ann.token, { title: 'Goa trip' });
check('admin renames', r.status === 200 && r.data.title === 'Goa trip');
r = await call('PATCH', `/conversations/${g}`, ann.token, { title: '   ' });
check('blank title rejected -> 400', r.status === 400);

// --- roles
r = await call('PATCH', `/conversations/${g}/members/${ben.id}`, ann.token, { role: 'admin' });
check('promote to admin', r.status === 200 && r.data.members.find((m) => m.id === ben.id)?.role === 'admin');
r = await call('PATCH', `/conversations/${g}/members/${ben.id}`, cat.token, { role: 'member' });
check('member cannot change roles -> 403', r.status === 403);

// --- remove
r = await call('DELETE', `/conversations/${g}/members/${cat.id}`, ben.token);
check('new admin removes a member', r.status === 200 && r.data.deleted === false);
r = await call('GET', `/conversations/${g}/messages`, cat.token);
check('removed member loses access -> 404', r.status === 404);
r = await call('POST', `/conversations/${g}/messages`, cat.token, { clientMsgId: randomUUID(), type: 'text', payload: { text: 'x' } });
check('removed member cannot send -> 404', r.status === 404);

// --- last admin rules
r = await call('PATCH', `/conversations/${g}/members/${ann.id}`, ann.token, { role: 'member' });
check('demoting yourself is fine while another admin exists', r.status === 200);
r = await call('PATCH', `/conversations/${g}/members/${ben.id}`, ben.token, { role: 'member' });
check('the last admin cannot be demoted -> 409', r.status === 409);
r = await call('POST', `/conversations/${g}/leave`, ben.token);
check('last admin can leave', r.status === 200);
r = await call('GET', '/conversations', ann.token);
const after = r.data.find((c) => c.id === g);
check('longest-standing member is promoted when the last admin leaves', after?.members.find((m) => m.id === ann.id)?.role === 'admin', JSON.stringify(after?.members));

// --- mute
r = await call('PUT', `/conversations/${g}/mute`, dan.token, { mutedUntil: new Date(Date.now() + 3600e3).toISOString() });
check('mute until a time', r.status === 200 && !!r.data.mutedUntil);
r = await call('PUT', `/conversations/${g}/mute`, dan.token, { mutedUntil: '2000-01-01T00:00:00Z' });
check('mute in the past -> 400', r.status === 400);
r = await call('PUT', `/conversations/${g}/mute`, dan.token, { mutedUntil: null });
check('unmute', r.status === 200 && r.data.mutedUntil === null);

// --- direct chats are not groups
r = await call('POST', '/conversations', ann.token, { userId: dan.id });
const direct = r.data.id;
r = await call('POST', `/conversations/${direct}/members`, ann.token, { userIds: [cat.id] });
check('direct chats have no member management -> 400', r.status === 400);

// --- everyone leaves -> group is deleted
await call('POST', `/conversations/${g}/leave`, dan.token);
r = await call('POST', `/conversations/${g}/leave`, ann.token);
check('last person leaving deletes the group', r.status === 200 && r.data.deleted === true);

danSock.close();
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
