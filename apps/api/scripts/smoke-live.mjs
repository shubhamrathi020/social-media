// End-to-end live streaming check with a real WebRTC publisher and subscriber.
// Needs: API running (OTP_DEV_CODE=123456) and the LiveKit container from infra/docker-compose.yml.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const {
  Room, RoomEvent, LocalVideoTrack, VideoSource, VideoFrame, VideoBufferType, VideoStream,
  TrackPublishOptions, TrackSource, TrackKind,
} = require('@livekit/rtc-node');
const { RoomServiceClient } = require('livekit-server-sdk');
const jwt = require('jsonwebtoken');

const HTTP = process.env.API_URL ?? 'http://localhost:3000/v1';
const WS = process.env.WS_URL ?? 'http://localhost:3000';
const CODE = process.env.OTP_DEV_CODE ?? '123456';
const LK_HTTP = process.env.LIVEKIT_HTTP_URL ?? 'http://localhost:7880';
const LK_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
const LK_SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret-devsecret-devsecret-devsecret';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout: ${label}`); })]);

async function call(method, path, token, body, headers = {}) {
  const res = await fetch(HTTP + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
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
const connectSocket = (user) =>
  new Promise((resolve) => {
    const s = io(WS, { auth: { token: user.token }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
  });
const emit = (s, ev, body) => new Promise((res) => s.emit(ev, body, res));
const once = (s, ev, pred = () => true, ms = 5000) =>
  withTimeout(new Promise((res) => { const h = (p) => { if (pred(p)) { s.off(ev, h); res(p); } }; s.on(ev, h); }), ms, ev);

const alice = await signup('alice'); // host
const bob = await signup('bob');     // friend + close friend
const carol = await signup('carol'); // friend, not close
const dave = await signup('dave');   // stranger
const erin = await signup('erin');   // second close friend
await befriend(alice, bob);
await befriend(alice, carol);
await befriend(alice, erin);
await call('PUT', `/close-friends/${bob.id}`, alice.token);
await call('PUT', `/close-friends/${erin.id}`, alice.token);

const [aliceS, bobS, carolS, erinS] = await Promise.all([connectSocket(alice), connectSocket(bob), connectSocket(carol), connectSocket(erin)]);
const bobStarted = [];
const carolStarted = [];
bobS.on('live:started', (p) => bobStarted.push(p));
carolS.on('live:started', (p) => carolStarted.push(p));

// --- create (close friends only)
let r = await call('POST', '/live', alice.token, { title: 'Hello live', audience: 'close_friends' });
check('create stream returns url, room and host token', r.status === 201 && r.data.url && r.data.room && r.data.token, JSON.stringify(r));
const live = r.data;
const hostClaims = jwt.decode(live.token);
check('host token can publish, bound to the room', hostClaims.video.canPublish === true && hostClaims.video.room === live.room && hostClaims.sub === alice.id, JSON.stringify(hostClaims.video));
r = await call('POST', '/live', alice.token, { title: 'again' });
check('second unfinished stream -> 409', r.status === 409);

const rooms = new RoomServiceClient(LK_HTTP, LK_KEY, LK_SECRET);
check('room exists on the media server', (await rooms.listRooms([live.room])).length === 1);

// --- not live yet
r = await call('POST', `/live/${live.id}/join`, bob.token);
check('viewers cannot join before the host starts -> 404', r.status === 404);

// --- host connects and publishes real video
const hostRoom = new Room();
await withTimeout(hostRoom.connect(live.url, live.token, { autoSubscribe: true, dynacast: false }), 15000, 'host connect');
const W = 320, H = 240;
const source = new VideoSource(W, H);
const track = LocalVideoTrack.createVideoTrack('camera', source);
await hostRoom.localParticipant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA }));
const pump = setInterval(() => {
  const buf = Buffer.alloc(W * H * 4, 0);
  const shade = (Date.now() / 20) % 255;
  for (let i = 0; i < buf.length; i += 4) { buf[i] = shade; buf[i + 1] = 90; buf[i + 2] = 160; buf[i + 3] = 255; }
  source.captureFrame(new VideoFrame(buf, W, H, VideoBufferType.RGBA));
}, 66);
check('host published a video track', hostRoom.localParticipant.trackPublications.size === 1);

// --- go live: only the audience is notified
r = await call('POST', `/live/${live.id}/start`, alice.token);
check('start marks it live', r.status === 200 && r.data.status === 'live' && r.data.host.id === alice.id, JSON.stringify(r));
await sleep(400);
check('close friend gets live:started', bobStarted.length === 1 && bobStarted[0].liveId === live.id);
check('plain friend is not notified (close_friends audience)', carolStarted.length === 0);

// --- visibility
r = await call('GET', '/live', bob.token);
check('close friend sees it in /live', r.data.length === 1 && r.data[0].id === live.id);
r = await call('GET', '/live', carol.token);
check('plain friend does not', r.data.length === 0);
r = await call('POST', `/live/${live.id}/join`, carol.token);
check('plain friend cannot join -> 404', r.status === 404);
r = await call('POST', `/live/${live.id}/join`, dave.token);
check('stranger cannot join -> 404', r.status === 404);

// --- viewer joins: token + real subscription to the host's video
r = await call('POST', `/live/${live.id}/join`, bob.token);
check('close friend gets a viewer token', r.status === 200 && r.data.token && r.data.stream.id === live.id, JSON.stringify(r));
const viewerClaims = jwt.decode(r.data.token);
check('viewer token cannot publish', viewerClaims.video.canPublish === false && viewerClaims.video.canSubscribe === true);

const viewerRoom = new Room();
const subscribed = new Promise((res) => viewerRoom.on(RoomEvent.TrackSubscribed, (t) => t.kind === TrackKind.KIND_VIDEO && res(t)));
await withTimeout(viewerRoom.connect(r.data.url, r.data.token, { autoSubscribe: true }), 15000, 'viewer connect');
const remoteTrack = await withTimeout(subscribed, 15000, 'viewer track subscribed').catch((e) => ({ error: e.message }));
check('viewer subscribed to the host video track', !remoteTrack.error, JSON.stringify(remoteTrack));
if (!remoteTrack.error) {
  const stream = new VideoStream(remoteTrack);
  const first = await withTimeout((async () => { for await (const f of stream) return f; })(), 15000, 'first frame').catch((e) => ({ error: e.message }));
  check('viewer received decoded video frames', !first.error && first.frame?.width > 0, JSON.stringify(first.error ?? {}));
}
let publishError = null;
try {
  const vs = new VideoSource(64, 64);
  await viewerRoom.localParticipant.publishTrack(LocalVideoTrack.createVideoTrack('x', vs), new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA }));
} catch (e) { publishError = e; }
check('viewer is refused when trying to publish', publishError !== null);

// --- viewer count via sockets, chat, hearts
const joinAck = await emit(bobS, 'live:join', { liveId: live.id });
check('socket join returns viewer count', joinAck.ok && joinAck.data.viewerCount === 1, JSON.stringify(joinAck));
const carolJoin = await emit(carolS, 'live:join', { liveId: live.id });
check('socket join refused outside the audience', carolJoin.ok === false && carolJoin.error.code === 404);
await emit(aliceS, 'live:join', { liveId: live.id });
await sleep(150);

const chatAtHost = once(aliceS, 'live:chat');
const sent = await emit(bobS, 'live:chat', { liveId: live.id, text: 'hi from bob' });
check('chat acked', sent.ok && sent.data.text === 'hi from bob', JSON.stringify(sent));
check('host receives chat in real time', (await chatAtHost.catch(() => null))?.author.id === bob.id);
const spam = await emit(bobS, 'live:chat', { liveId: live.id, text: 'again immediately' });
check('chat is rate limited -> 429', spam.ok === false && spam.error.code === 429, JSON.stringify(spam));
const heartAtHost = once(aliceS, 'live:heart');
const hb = await emit(bobS, 'live:heart', { liveId: live.id });
check('heart counted and broadcast', hb.ok && hb.data.total === 1 && (await heartAtHost.catch(() => null))?.total === 1);
r = await call('POST', `/live/${live.id}/join`, bob.token);
check('late joiner gets recent chat', r.data.recentChat.length === 1 && r.data.recentChat[0].text === 'hi from bob');

check('host socket is not counted as a viewer', (await emit(bobS, 'live:join', { liveId: live.id })).data.viewerCount === 1);
const secondDevice = await connectSocket(bob);
check('same person on a second device counts once', (await emit(secondDevice, 'live:join', { liveId: live.id })).data.viewerCount === 1);
const viewers = once(aliceS, 'live:viewers', (p) => p.count === 2);
await emit(erinS, 'live:join', { liveId: live.id });
check('viewer count broadcast updates to 2', !!(await viewers.catch(() => null)));
secondDevice.close();

// --- webhook authentication
r = await call('POST', '/live/webhook', null, { event: 'room_finished', room: { name: live.room } });
check('unsigned webhook rejected -> 403', r.status === 403);

// --- end
const endedAtViewer = once(bobS, 'live:ended');
r = await call('POST', `/live/${live.id}/end`, bob.token);
check('only the host can end -> 404', r.status === 404);
r = await call('POST', `/live/${live.id}/end`, alice.token);
check('host ends the stream', r.status === 204);
check('viewers are told it ended', !!(await endedAtViewer.catch(() => null)));
await sleep(500);
check('room removed from the media server', (await rooms.listRooms([live.room])).length === 0);
r = await call('POST', `/live/${live.id}/join`, bob.token);
check('cannot join an ended stream -> 404', r.status === 404);
r = await call('POST', '/live', alice.token, { title: 'next one' });
check('host can start a new stream afterwards', r.status === 201);
await call('POST', `/live/${r.data.id}/end`, alice.token);

clearInterval(pump);
await hostRoom.disconnect();
await viewerRoom.disconnect();
[aliceS, bobS, carolS, erinS].forEach((s) => s.close());
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
