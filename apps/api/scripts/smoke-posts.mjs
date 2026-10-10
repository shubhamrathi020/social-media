// End-to-end posts check. Needs the API running with OTP_DEV_CODE=123456.
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

let colour = 0;
async function readyImage(user, purpose = 'post') {
  colour += 17;
  const png = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: colour % 255, g: 80, b: 160 } },
  }).png().toBuffer();
  const up = await call('POST', '/media/uploads', user.token, { kind: 'image', purpose, mime: 'image/png', sizeBytes: png.length });
  await fetch(up.data.upload.url, { method: 'PUT', headers: up.data.upload.headers, body: png });
  await call('POST', `/media/${up.data.id}/complete`, user.token);
  for (let i = 0; i < 60; i++) {
    const m = await call('GET', `/media/${up.data.id}`, user.token);
    if (m.data.status === 'ready') return up.data.id;
    await sleep(250);
  }
  throw new Error('media never became ready');
}
const images = (user, n, purpose) => Promise.all(Array.from({ length: n }, () => readyImage(user, purpose)));

const alice = await signup('alice');
const bob = await signup('bob');
const carol = await signup('carol');
const dave = await signup('dave'); // stranger
await befriend(alice, bob);
await befriend(alice, carol);

// --- create posts
let r = await call('POST', '/posts', alice.token, { caption: 'six', mediaIds: await images(alice, 6) });
check('6 slides rejected -> 400', r.status === 400, JSON.stringify(r.data));
r = await call('POST', '/posts', alice.token, { caption: 'none', mediaIds: [] });
check('0 slides rejected -> 400', r.status === 400);
r = await call('POST', '/posts', alice.token, { mediaIds: [await readyImage(bob)] });
check("someone else's media rejected -> 400", r.status === 400);
r = await call('POST', '/posts', alice.token, { mediaIds: [await readyImage(alice, 'avatar')] });
check('avatar media cannot be used in a post -> 400', r.status === 400);

const five = await images(alice, 5);
r = await call('POST', '/posts', alice.token, { caption: 'five slides', audience: 'friends', mediaIds: five });
check('5 slides accepted', r.status === 201 && r.data.slides.length === 5, JSON.stringify(r.data).slice(0, 300));
check('slides ordered with media urls', r.data.slides.every((s, i) => s.position === i + 1 && s.media?.url));
const friendsPost = r.data.id;
r = await call('POST', '/posts', alice.token, { caption: 'reuse', mediaIds: [five[0]] });
check('media cannot be reused -> 409', r.status === 409, JSON.stringify(r));

r = await call('POST', '/posts', alice.token, { caption: 'public one', audience: 'public', mediaIds: await images(alice, 1) });
const publicPost = r.data.id;
await befriend(alice, bob).catch(() => undefined);
await call('PUT', `/close-friends/${bob.id}`, alice.token);
r = await call('POST', '/posts', alice.token, { caption: 'close only', audience: 'close_friends', mediaIds: await images(alice, 1) });
const closePost = r.data.id;

// --- visibility
for (const [label, viewer, id, expected] of [
  ['author sees friends post', alice, friendsPost, 200],
  ['friend sees friends post', carol, friendsPost, 200],
  ['stranger cannot see friends post', dave, friendsPost, 404],
  ['stranger sees public post', dave, publicPost, 200],
  ['close friend sees close_friends post', bob, closePost, 200],
  ['plain friend cannot see close_friends post', carol, closePost, 404],
  ['stranger cannot see close_friends post', dave, closePost, 404],
]) {
  r = await call('GET', `/posts/${id}`, viewer.token);
  check(label, r.status === expected, String(r.status));
}

// --- feed + profile
r = await call('GET', '/feed', carol.token);
const captions = r.data.items.map((p) => p.caption);
check('carol feed: friends+public, not close-only', captions.includes('five slides') && captions.includes('public one') && !captions.includes('close only'), JSON.stringify(captions));
check('feed newest first', captions[0] === 'public one');
r = await call('GET', '/feed', bob.token);
check('bob (close friend) feed includes close-only', r.data.items.some((p) => p.caption === 'close only'));
r = await call('GET', '/feed', dave.token);
check('stranger feed is empty', r.data.items.length === 0);
r = await call('GET', '/feed?limit=1', carol.token);
check('feed pagination cursor', r.data.items.length === 1 && !!r.data.nextCursor);
r = await call('GET', `/feed?limit=1&cursor=${r.data.nextCursor}`, carol.token);
check('feed second page', r.data.items.length === 1 && r.data.items[0].caption === 'five slides');
r = await call('GET', `/users/${alice.id}/posts`, dave.token);
check('stranger profile shows only public', r.data.items.length === 1 && r.data.items[0].caption === 'public one');
r = await call('GET', `/users/${alice.id}/posts`, alice.token);
check('own profile shows all', r.data.items.length === 3);

// --- reactions (like/dislike) + live counters
const carolSock = io(WS, { auth: { token: carol.token }, transports: ['websocket'], reconnection: false });
await new Promise((res) => carolSock.on('connect', res));
const sub = await new Promise((res) => carolSock.emit('post:subscribe', { postId: friendsPost }, res));
check('subscribe to visible post', sub.ok === true, JSON.stringify(sub));
const subDenied = await new Promise((res) => carolSock.emit('post:subscribe', { postId: closePost }, res));
check('cannot subscribe to post you cannot see', subDenied.ok === false && subDenied.error.code === 404);
const counters = [];
carolSock.on('post:counters', (p) => counters.push(p));

r = await call('PUT', `/posts/${friendsPost}/reaction`, bob.token, { value: 1 });
check('like', r.status === 200 && r.data.likeCount === 1 && r.data.myReaction === 1, JSON.stringify(r.data));
r = await call('PUT', `/posts/${friendsPost}/reaction`, bob.token, { value: 1 });
check('like is idempotent', r.data.likeCount === 1);
r = await call('PUT', `/posts/${friendsPost}/reaction`, carol.token, { value: -1 });
check('dislike hides count from non-author', r.status === 200 && r.data.dislikeCount === undefined && r.data.likeCount === 1);
r = await call('GET', `/posts/${friendsPost}`, alice.token);
check('author sees dislike count', r.data.likeCount === 1 && r.data.dislikeCount === 1, JSON.stringify(r.data));
r = await call('PUT', `/posts/${friendsPost}/reaction`, carol.token, { value: 1 });
check('switch dislike -> like moves counts', r.data.likeCount === 2);
r = await call('GET', `/posts/${friendsPost}`, alice.token);
check('author dislike count back to 0', r.data.dislikeCount === 0);
r = await call('DELETE', `/posts/${friendsPost}/reaction`, bob.token);
check('remove reaction', r.data.likeCount === 1 && r.data.myReaction === null);
r = await call('PUT', `/posts/${friendsPost}/reaction`, dave.token, { value: 1 });
check('stranger cannot react -> 404', r.status === 404);
r = await call('PUT', `/posts/${friendsPost}/reaction`, bob.token, { value: 2 });
check('invalid reaction value -> 400', r.status === 400);
await sleep(200);
check('live counters broadcast to subscribers', counters.length >= 3 && counters.at(-1).likeCount === 1, JSON.stringify(counters));

// concurrency: 10 parallel likes from distinct users would need 10 accounts; hammer same user instead
await Promise.all(Array.from({ length: 8 }, () => call('PUT', `/posts/${friendsPost}/reaction`, bob.token, { value: 1 })));
r = await call('GET', `/posts/${friendsPost}`, alice.token);
check('parallel duplicate likes count once', r.data.likeCount === 2, JSON.stringify(r.data.likeCount));

// socket react
const viaSocket = await new Promise((res) => carolSock.emit('post:react', { postId: friendsPost, value: null }, res));
check('react over socket', viaSocket.ok && viaSocket.data.likeCount === 1, JSON.stringify(viaSocket));

// --- comments
const newComment = new Promise((res) => carolSock.once('comment:new', res));
r = await call('POST', `/posts/${friendsPost}/comments`, bob.token, { body: 'nice one' });
check('comment created', r.status === 201 && r.data.body === 'nice one' && r.data.author.id === bob.id, JSON.stringify(r.data));
const c1 = r.data.id;
check('comment:new pushed to subscriber', (await Promise.race([newComment, sleep(2000).then(() => null)]))?.id === c1);
r = await call('POST', `/posts/${friendsPost}/comments`, carol.token, { body: 'agreed', parentId: c1 });
check('reply created', r.status === 201 && r.data.parentId === c1);
const reply = r.data.id;
r = await call('POST', `/posts/${friendsPost}/comments`, carol.token, { body: 'nested', parentId: reply });
check('nested reply rejected -> 400', r.status === 400);
r = await call('POST', `/posts/${friendsPost}/comments`, dave.token, { body: 'hi' });
check('stranger cannot comment -> 404', r.status === 404);
r = await call('POST', `/posts/${friendsPost}/comments`, bob.token, { body: '   ' });
check('blank comment rejected -> 400', r.status === 400);
r = await call('GET', `/posts/${friendsPost}`, alice.token);
check('post comment count = 2', r.data.commentCount === 2);
r = await call('GET', `/posts/${friendsPost}/comments`, alice.token);
check('top-level comments exclude replies, with replyCount', r.data.items.length === 1 && r.data.items[0].replyCount === 1);
r = await call('GET', `/posts/${friendsPost}/comments?parentId=${c1}`, alice.token);
check('replies listed', r.data.items.length === 1 && r.data.items[0].id === reply);
r = await call('PUT', `/comments/${c1}/reaction`, alice.token, { value: 1 });
check('like a comment', r.status === 200 && r.data.likeCount === 1);
r = await call('DELETE', `/comments/${reply}`, dave.token);
check('stranger cannot delete comment -> 404', r.status === 404);
r = await call('DELETE', `/comments/${reply}`, bob.token);
check("bob cannot delete carol's reply -> 403", r.status === 403);
r = await call('DELETE', `/comments/${reply}`, alice.token);
check('post author can delete a comment on their post', r.status === 204);
r = await call('GET', `/posts/${friendsPost}`, alice.token);
check('comment count decremented', r.data.commentCount === 1);
r = await call('DELETE', `/comments/${c1}`, bob.token);
check('author deletes own comment', r.status === 204);
r = await call('GET', `/posts/${friendsPost}/comments`, alice.token);
check('deleted comment gone from list', r.data.items.length === 0);

// comment pagination
for (let i = 0; i < 5; i++) await call('POST', `/posts/${friendsPost}/comments`, bob.token, { body: `c${i}` });
r = await call('GET', `/posts/${friendsPost}/comments?limit=2`, alice.token);
check('comments paginate newest first', r.data.items.length === 2 && r.data.items[0].body === 'c4' && !!r.data.nextCursor);
r = await call('GET', `/posts/${friendsPost}/comments?limit=10&cursor=${r.data.nextCursor}`, alice.token);
check('comments next page', r.data.items.length === 3 && r.data.items[0].body === 'c2');

// --- blocks hide comments and posts
await call('PUT', `/blocks/${bob.id}`, carol.token);
r = await call('GET', `/posts/${friendsPost}/comments?limit=10`, carol.token);
check("blocked user's comments hidden", r.data.items.every((c) => c.author.id !== bob.id), JSON.stringify(r.data.items.length));
await call('DELETE', `/blocks/${bob.id}`, carol.token);

// --- edit / delete
r = await call('PATCH', `/posts/${friendsPost}`, bob.token, { caption: 'hijack' });
check('non-author cannot edit -> 403', r.status === 403, JSON.stringify(r));
r = await call('PATCH', `/posts/${friendsPost}`, alice.token, { caption: 'edited' });
check('author edits caption', r.status === 200 && r.data.caption === 'edited');
r = await call('DELETE', `/posts/${friendsPost}`, bob.token);
check('non-author cannot delete -> 403', r.status === 403);
r = await call('DELETE', `/posts/${friendsPost}`, alice.token);
check('author deletes post', r.status === 204);
r = await call('GET', `/posts/${friendsPost}`, carol.token);
check('deleted post -> 404', r.status === 404);

carolSock.close();
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
