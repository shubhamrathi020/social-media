// End-to-end stories/statuses check. Needs the API running with OTP_DEV_CODE=123456.
// Set DATABASE_URL to also verify expiry handling by back-dating rows.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const sharp = require('sharp');

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
let shade = 0;
async function readyImage(user, purpose) {
  shade += 23;
  const png = await sharp({ create: { width: 270, height: 480, channels: 3, background: { r: shade % 255, g: 120, b: 60 } } })
    .png().toBuffer();
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

const alice = await signup('alice');
const bob = await signup('bob');     // friend, close friend
const carol = await signup('carol'); // friend, not close
const dave = await signup('dave');   // stranger
await befriend(alice, bob);
await befriend(alice, carol);
await call('PUT', `/close-friends/${bob.id}`, alice.token);

const bobSock = io(WS, { auth: { token: bob.token }, transports: ['websocket'], reconnection: false });
const carolSock = io(WS, { auth: { token: carol.token }, transports: ['websocket'], reconnection: false });
await Promise.all([bobSock, carolSock].map((s) => new Promise((res) => s.on('connect', res))));
const bobEvents = [];
const carolEvents = [];
bobSock.on('story:new', (p) => bobEvents.push(p));
carolSock.on('story:new', (p) => carolEvents.push(p));

// --- validation
let r = await call('POST', '/stories', alice.token, { mediaId: await readyImage(alice, 'post') });
check('story rejects media made for a post -> 400', r.status === 400);
r = await call('POST', '/stories', alice.token, { text: 'no media' });
check('story needs media -> 400', r.status === 400);
r = await call('POST', '/statuses', alice.token, {});
check('empty status -> 400', r.status === 400);

// --- create
r = await call('POST', '/stories', alice.token, { mediaId: await readyImage(alice, 'story'), text: 'hello world' });
check('create story', r.status === 201 && r.data.kind === 'story' && r.data.media?.url, JSON.stringify(r));
const story1 = r.data.id;
check('expires in ~24h', Math.abs(new Date(r.data.expiresAt) - Date.now() - 86400000) < 60000);
r = await call('POST', '/stories', alice.token, { mediaId: await readyImage(alice, 'story'), audience: 'close_friends' });
const closeStory = r.data.id;
check('create close-friends story', r.status === 201 && r.data.audience === 'close_friends');
r = await call('POST', '/statuses', alice.token, { text: 'feeling good', background: '#112233' });
check('create text status', r.status === 201 && r.data.kind === 'status' && r.data.text === 'feeling good' && r.data.background === '#112233');
const status1 = r.data.id;
r = await call('POST', '/statuses', alice.token, { text: 'x', background: 'red' });
check('invalid colour -> 400', r.status === 400);

await sleep(300);
check('close friend notified of both stories', bobEvents.filter((e) => e.authorId === alice.id).length === 2, JSON.stringify(bobEvents));
check('plain friend notified only of the friends story', carolEvents.length === 1 && carolEvents[0].itemId === story1, JSON.stringify(carolEvents));

// --- feeds and audience
r = await call('GET', '/stories/feed', carol.token);
check('friend sees friends story, not close-only', r.data.length === 1 && r.data[0].items.length === 1 && r.data[0].items[0].id === story1, JSON.stringify(r.data.map((g) => g.items.map((i) => i.id))));
check('group marks unseen', r.data[0].hasUnseen === true && r.data[0].author.id === alice.id);
r = await call('GET', '/stories/feed', bob.token);
check('close friend sees both', r.data[0].items.length === 2);
r = await call('GET', '/stories/feed', dave.token);
check('stranger sees nothing', r.data.length === 0);
r = await call('GET', '/stories/feed', alice.token);
check('author feed starts with me', r.data[0].isMe === true && r.data[0].items.length === 2);
r = await call('GET', '/statuses/feed', carol.token);
check('status feed separate from story feed', r.data.length === 1 && r.data[0].items[0].id === status1);

// --- views
r = await call('POST', `/stories/${closeStory}/view`, carol.token);
check('cannot view a story outside your audience -> 404', r.status === 404);
r = await call('POST', `/stories/${story1}/view`, carol.token);
check('view recorded', r.status === 204);
await call('POST', `/stories/${story1}/view`, carol.token);
await call('POST', `/stories/${story1}/view`, bob.token);
await call('POST', `/stories/${story1}/view`, alice.token); // own view does not count
r = await call('GET', `/stories/${story1}/viewers`, alice.token);
check('viewer list has 2 unique viewers', r.status === 200 && r.data.length === 2, JSON.stringify(r.data.length));
r = await call('GET', `/stories/${story1}/viewers`, carol.token);
check('viewers visible to author only -> 403', r.status === 403);
r = await call('GET', '/stories/feed', carol.token);
check('seen state persists', r.data[0].hasUnseen === false && r.data[0].items[0].seen === true);
r = await call('GET', '/stories/feed', alice.token);
const mine = r.data[0].items.find((i) => i.id === story1);
check('own item has viewCount', mine.viewCount === 2, JSON.stringify(mine));

// --- reply goes to DM
r = await call('POST', `/stories/${story1}/reply`, carol.token, { text: '🔥' });
check('reply creates a DM', r.status === 201 && !!r.data.conversationId, JSON.stringify(r));
const hist = await call('GET', `/conversations/${r.data.conversationId}/messages`, alice.token);
check('author receives the reply with story context', hist.data[0]?.payload.text === '🔥' && hist.data[0].payload.storyId === story1, JSON.stringify(hist.data[0]));
r = await call('POST', `/stories/${story1}/reply`, alice.token, { text: 'me' });
check('cannot reply to own story -> 400', r.status === 400);
r = await call('POST', `/stories/${closeStory}/reply`, carol.token, { text: 'hi' });
check('cannot reply outside audience -> 404', r.status === 404);

// --- privacy setting: nobody
await call('PATCH', '/settings', alice.token, { privacy: { stories: 'nobody' } });
r = await call('GET', '/stories/feed', carol.token);
check("privacy.stories=nobody hides all from friends", r.data.length === 0);
r = await call('GET', '/stories/feed', alice.token);
check('author still sees own', r.data[0].items.length === 2);
await call('PATCH', '/settings', alice.token, { privacy: { stories: 'friends' } });

// --- privacy.stories = everyone lets non-friends in, until a block
await call('PATCH', '/settings', alice.token, { privacy: { stories: 'everyone' } });
r = await call('GET', '/stories/feed', dave.token);
check("'everyone' shows friends-audience stories to a stranger", r.data.length === 1 && r.data[0].items.every((i) => i.audience === 'friends'), JSON.stringify(r.data.length));
r = await call('GET', '/stories/feed', carol.token);
check("'everyone' still hides close-friends items from plain friends", r.data[0].items.every((i) => i.id !== closeStory));
await call('PUT', `/blocks/${dave.id}`, alice.token);
r = await call('GET', '/stories/feed', dave.token);
check('block hides stories even when privacy is everyone', r.data.length === 0);
await call('DELETE', `/blocks/${dave.id}`, alice.token);
await call('PATCH', '/settings', alice.token, { privacy: { stories: 'friends' } });

// --- delete
r = await call('DELETE', `/stories/${story1}`, carol.token);
check("cannot delete someone else's -> 404", r.status === 404);
r = await call('DELETE', `/stories/${story1}`, alice.token);
check('author deletes', r.status === 204);
r = await call('GET', '/stories/feed', bob.token);
check('deleted story gone from feed', r.data[0].items.every((i) => i.id !== story1));

// --- expiry (back-date through the database)
let pg;
try {
  const { Client } = require('pg');
  pg = new Client({ connectionString: DB });
  await pg.connect();
  await pg.query(`UPDATE stories SET expires_at = now() - interval '1 minute' WHERE id = $1`, [closeStory]);
  r = await call('GET', '/stories/feed', bob.token);
  check('expired story disappears immediately', r.data.length === 0 || r.data[0].items.every((i) => i.id !== closeStory));
  r = await call('POST', `/stories/${closeStory}/view`, bob.token);
  check('cannot view an expired story -> 404', r.status === 404);
  await pg.query(`UPDATE stories SET expires_at = now() - interval '2 hours' WHERE id = $1`, [closeStory]);
  console.log('INFO  back-dated one story to 2h past expiry; the maintenance job should purge it');
} catch (e) {
  console.log('SKIP  expiry checks need the pg module and DATABASE_URL:', e.message);
} finally {
  await pg?.end();
}

bobSock.close();
carolSock.close();
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
