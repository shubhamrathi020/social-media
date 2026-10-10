// End-to-end account export, deletion and purge.
// Needs the API running with OTP_DEV_CODE=123456 and MAINTENANCE_INTERVAL_MS=2000 (so the purge runs quickly),
// and DATABASE_URL reachable to back-date the deletion past the retention period.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { Client } = require('pg');

const HTTP = process.env.API_URL ?? 'http://localhost:3000/v1';
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
  return { status: res.status, data, headers: res.headers };
}
async function login(phone, label) {
  await call('POST', '/auth/otp/request', null, { phone });
  const r = await call('POST', '/auth/otp/verify', null, { phone, code: CODE, device: { platform: 'android' } });
  if (label) await call('PATCH', '/users/me', r.data.accessToken, { displayName: label });
  return { id: r.data.userId, token: r.data.accessToken, refresh: r.data.refreshToken, phone, isNew: r.data.isNewUser };
}
const newPhone = () => '+1415' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
async function befriend(a, b) {
  const r = await call('POST', '/friends/requests', a.token, { toUser: b.id });
  await call('POST', `/friends/requests/${r.data.id}/accept`, b.token);
}
async function readyImage(user, purpose) {
  const png = await sharp({ create: { width: 160, height: 160, channels: 3, background: '#884422' } }).png().toBuffer();
  const up = await call('POST', '/media/uploads', user.token, { kind: 'image', purpose, mime: 'image/png', sizeBytes: png.length });
  await fetch(up.data.upload.url, { method: 'PUT', headers: up.data.upload.headers, body: png });
  await call('POST', `/media/${up.data.id}/complete`, user.token);
  for (let i = 0; i < 60; i++) {
    const m = await call('GET', `/media/${up.data.id}`, user.token);
    if (m.data.status === 'ready') return m.data;
    await sleep(250);
  }
  throw new Error('media not ready');
}

const alice = await login(newPhone(), 'alice');
const bob = await login(newPhone(), 'bob');
const carol = await login(newPhone(), 'carol');
await befriend(alice, bob);
await befriend(alice, carol);
await befriend(bob, carol);

// Alice leaves traces everywhere.
const aliceImg = await readyImage(alice, 'post');
let r = await call('POST', '/posts', alice.token, { caption: 'alice post', audience: 'public', mediaIds: [aliceImg.id] });
const alicePost = r.data.id;
const bobImg = await readyImage(bob, 'post');
r = await call('POST', '/posts', bob.token, { caption: 'bob post', audience: 'friends', mediaIds: [bobImg.id] });
const bobPost = r.data.id;
await call('PUT', `/posts/${bobPost}/reaction`, alice.token, { value: 1 });
await call('POST', `/posts/${bobPost}/comments`, alice.token, { body: 'nice, from alice' });
await call('POST', `/posts/${bobPost}/comments`, carol.token, { body: 'from carol' });
r = await call('POST', '/conversations', alice.token, { userId: bob.id });
const dm = r.data.id;
await call('POST', `/conversations/${dm}/messages`, alice.token, { clientMsgId: randomUUID(), type: 'text', payload: { text: 'hi bob' } });
r = await call('POST', '/conversations', alice.token, { title: 'trio', memberIds: [bob.id, carol.id] });
const group = r.data.id;
await call('POST', `/conversations/${group}/messages`, alice.token, { clientMsgId: randomUUID(), type: 'text', payload: { text: 'hi all' } });

// --- export
r = await call('GET', '/users/me/export', alice.token);
check('export downloads as an attachment', r.status === 200 && /attachment/.test(r.headers.get('content-disposition') ?? ''));
const x = r.data;
check('export has profile, friends, posts, comments, messages, media', x.profile?.id === alice.id && x.friends.length === 2 &&
  x.posts.length === 1 && x.comments.length === 1 && x.messages.length >= 2 && x.media.length >= 1 && x.reactions.length === 1,
  JSON.stringify({ friends: x.friends?.length, posts: x.posts?.length, comments: x.comments?.length, messages: x.messages?.length, media: x.media?.length }));
check('exported messages are readable', x.messages.some((m) => m.payload?.text === 'hi bob'));
check("export holds only the user's own comments", x.comments.every((c) => c.body === 'nice, from alice'));
r = await call('GET', '/users/me/export', bob.token);
check("bob's export does not contain alice's private data", !JSON.stringify(r.data).includes(alice.phone));

// --- delete
r = await call('GET', `/posts/${bobPost}`, bob.token);
const before = r.data;
r = await call('DELETE', '/users/me', alice.token);
check('delete account', r.status === 204);

r = await call('POST', '/auth/refresh', null, { refreshToken: alice.refresh });
check('sessions are revoked', r.status === 401);
r = await call('GET', '/friends', bob.token);
check('gone from friend lists immediately', r.data.every((f) => f.id !== alice.id));
r = await call('GET', `/posts/${alicePost}`, carol.token);
check('her public post is gone immediately', r.status === 404);
r = await call('GET', `/posts/${bobPost}`, bob.token);
check('her like and comment no longer count', r.data.likeCount === before.likeCount - 1 && r.data.commentCount === before.commentCount - 1,
  JSON.stringify({ before: [before.likeCount, before.commentCount], after: [r.data.likeCount, r.data.commentCount] }));
r = await call('GET', `/posts/${bobPost}/comments`, bob.token);
check('her comment is hidden', r.data.items.every((c) => c.body !== 'nice, from alice'));
r = await call('GET', '/conversations', bob.token);
const g = r.data.find((c) => c.id === group);
check('she left the group and an admin was promoted', g && g.members.every((m) => m.id !== alice.id) && g.members.some((m) => m.role === 'admin'), JSON.stringify(g?.members));
check('the direct chat stays until the purge', r.data.some((c) => c.id === dm));
r = await call('GET', `/users/search?q=alice`, carol.token);
check('not findable in search', r.data.every((u) => u.id !== alice.id));

await sleep(31_000); // the earlier sign-in started the 30 s resend cooldown for this number
const again = await login(alice.phone, null);
check('the phone number can sign up again as a new account', again.isNew === true && again.id !== alice.id);

// --- purge after the retention period
const pg = new Client({ connectionString: DB });
await pg.connect();
await pg.query(`UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = $1`, [alice.id]);
let gone = false;
for (let i = 0; i < 30 && !gone; i++) {
  await sleep(1000);
  gone = (await pg.query('SELECT 1 FROM users WHERE id = $1', [alice.id])).rowCount === 0;
}
check('account row purged after the retention period', gone);
const leftMedia = await pg.query('SELECT count(*)::int AS n FROM media WHERE owner_id = $1', [alice.id]);
check('her media rows are gone', leftMedia.rows[0].n === 0);
const obj = await fetch(aliceImg.url);
check('her stored files are deleted', obj.status === 404, String(obj.status));
const msgs = await pg.query('SELECT count(*)::int AS n FROM messages WHERE sender_id = $1', [alice.id]);
check('her messages are gone', msgs.rows[0].n === 0);
await pg.end();
r = await call('GET', '/conversations', bob.token);
check('the direct chat is removed by the purge', r.data.every((c) => c.id !== dm));
check('the group survives', r.data.some((c) => c.id === group));

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
