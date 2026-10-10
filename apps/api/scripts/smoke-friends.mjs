import { createHash } from 'node:crypto';

const B = 'http://localhost:3000/v1';
const CODE = '123456';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};

async function call(method, path, token, body) {
  const res = await fetch(B + path, {
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
  const name = `${label}_${Math.random().toString(36).slice(2, 7)}`;
  await call('PATCH', '/users/me', r.data.accessToken, { username: name, displayName: label });
  return { phone, id: r.data.userId, token: r.data.accessToken, name };
}

const A = await signup('alice');
const Bb = await signup('bob');
const C = await signup('carol');
const D = await signup('dave');

// A -> B request, B accepts
let r = await call('POST', '/friends/requests', A.token, { toUser: Bb.id });
check('send request', r.status === 201, JSON.stringify(r));
const reqAB = r.data.id;
r = await call('POST', '/friends/requests', A.token, { toUser: Bb.id });
check('duplicate request -> 409', r.status === 409);
r = await call('POST', '/friends/requests', A.token, { toUser: A.id });
check('self request -> 400', r.status === 400);
r = await call('GET', '/friends/requests?direction=in', Bb.token);
check('incoming list has 1', r.status === 200 && r.data.length === 1 && r.data[0].user.id === A.id);
r = await call('POST', `/friends/requests/${reqAB}/accept`, A.token);
check('sender cannot accept -> 404', r.status === 404);
r = await call('POST', `/friends/requests/${reqAB}/accept`, Bb.token);
check('accept', r.status === 200 && r.data.friendId === A.id);
r = await call('GET', '/friends', A.token);
check('friends list shows bob', r.data?.length === 1 && r.data[0].id === Bb.id);

// B <-> C friends (so A has C as mutual-friend suggestion)
r = await call('POST', '/friends/requests', Bb.token, { toUser: C.id });
await call('POST', `/friends/requests/${r.data.id}/accept`, C.token);
r = await call('GET', '/friends/suggestions', A.token);
check('suggest carol via mutual', r.data?.some((s) => s.id === C.id && s.mutualCount === 1 && s.reason === 'mutual'), JSON.stringify(r.data));
check('does not suggest existing friend', !r.data?.some((s) => s.id === Bb.id));

// contact sync: A uploads hash of D's phone -> D suggested as contact
const hash = createHash('sha256').update(D.phone).digest('hex');
r = await call('POST', '/contacts/sync', A.token, { hashes: [hash] });
check('contacts matched 1', r.data?.matched === 1, JSON.stringify(r.data));
r = await call('GET', '/friends/suggestions', A.token);
check('suggest dave via contact', r.data?.some((s) => s.id === D.id && s.reason === 'contact'));
r = await call('POST', `/friends/suggestions/${D.id}/dismiss`, A.token);
r = await call('GET', '/friends/suggestions', A.token);
check('dismissed suggestion hidden', !r.data?.some((s) => s.id === D.id));

// close friends
r = await call('PUT', `/close-friends/${C.id}`, A.token);
check('cannot close-friend a non-friend -> 400', r.status === 400);
r = await call('PUT', `/close-friends/${Bb.id}`, A.token);
check('add close friend', r.status === 204);
r = await call('GET', '/friends', A.token);
check('isCloseFriend flag', r.data?.[0]?.isCloseFriend === true);

// mutual request auto-accept: C -> D and D -> C
r = await call('POST', '/friends/requests', C.token, { toUser: D.id });
r = await call('POST', '/friends/requests', D.token, { toUser: C.id });
check('crossing requests auto-accept', r.status === 201 || r.status === 200, JSON.stringify(r));
r = await call('GET', `/users/${D.id}`, C.token);
check('relationship = friends', r.data?.relationship === 'friends', JSON.stringify(r.data));

// block: B blocks A -> friendship + close friend gone, A can't see B
r = await call('PUT', `/blocks/${A.id}`, Bb.token);
check('block', r.status === 204);
r = await call('GET', '/friends', A.token);
check('friendship removed on block', r.data?.length === 0);
r = await call('GET', '/close-friends', A.token);
check('close friend removed on block', r.data?.length === 0);
r = await call('GET', `/users/${Bb.id}`, A.token);
check('blocked-by user looks nonexistent -> 404', r.status === 404);
r = await call('POST', '/friends/requests', A.token, { toUser: Bb.id });
check('blocked cannot send request -> 403', r.status === 403);
r = await call('GET', `/users/search?q=${Bb.name}`, A.token);
check('blocker hidden from search', r.data?.length === 0, JSON.stringify(r.data));
r = await call('GET', `/users/${A.id}`, Bb.token);
check('blocker sees relationship=blocked', r.data?.relationship === 'blocked');
r = await call('DELETE', `/blocks/${A.id}`, Bb.token);
check('unblock', r.status === 204);

// unfriend
r = await call('DELETE', `/friends/${C.id}`, D.token);
check('unfriend', r.status === 204);
r = await call('GET', '/friends', D.token);
check('friend list empty after unfriend', r.data?.length === 0);

// search with relationship
r = await call('GET', `/users/search?q=${Bb.name}`, C.token);
check('search finds bob', r.data?.[0]?.id === Bb.id && ['friends', 'none'].includes(r.data[0].relationship));

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
