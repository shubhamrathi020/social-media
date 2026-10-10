// Load test against a seeded database. See docs/PERFORMANCE.md for how to seed and what the numbers mean.
//
//   RATE_LIMIT_USER_PER_MIN=10000000 node dist/main.js     # rate limits would otherwise cut the test short
//   DATABASE_URL=... JWT_ACCESS_SECRET=... node scripts/load-test.mjs
//
// It signs tokens directly with the API secret for seeded users (phone prefix +999), so no OTP is involved.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const autocannon = require('autocannon');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const { io } = require('socket.io-client');

const API = process.env.API_URL ?? 'http://localhost:3000';
const DB = process.env.DATABASE_URL ?? 'postgresql://social:social@localhost:5433/social';
const SECRET = process.env.JWT_ACCESS_SECRET ?? 'change-me';
const DURATION = Number(process.env.LOAD_SECONDS ?? 10);
const CONNECTIONS = Number(process.env.LOAD_CONNECTIONS ?? 50);
const SOCKET_SENDERS = Number(process.env.LOAD_SOCKETS ?? 40);
const MESSAGES_EACH = Number(process.env.LOAD_MESSAGES ?? 25);

const sign = (userId) => jwt.sign({ sub: userId, sid: '00000000-0000-4000-8000-000000000000' }, SECRET, { expiresIn: '1h' });
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];

const pg = new Client({ connectionString: DB });
await pg.connect();

// The seeded user with the most friends is the interesting viewer.
const hub = (
  await pg.query(`
    SELECT u.id, count(*)::int AS friends FROM users u
      JOIN friendships f ON f.user_a = u.id OR f.user_b = u.id
     WHERE u.phone LIKE '+999%' GROUP BY u.id ORDER BY friends DESC LIMIT 1`)
).rows[0];
if (!hub) {
  console.error('No seeded users found. Seed first (see docs/PERFORMANCE.md).');
  process.exit(1);
}
const token = sign(hub.id);
console.log(`viewer has ${hub.friends} friends; ${DURATION}s per endpoint at ${CONNECTIONS} connections\n`);

const rows = [];
for (const [name, path] of [
  ['GET /v1/health', '/v1/health'],
  ['GET /v1/users/me', '/v1/users/me'],
  ['GET /v1/feed', '/v1/feed?limit=20'],
  ['GET /v1/conversations', '/v1/conversations'],
  ['GET /v1/notifications', '/v1/notifications'],
]) {
  const r = await autocannon({
    url: API + path,
    connections: CONNECTIONS,
    duration: DURATION,
    headers: { authorization: `Bearer ${token}` },
  });
  rows.push({
    endpoint: name,
    'req/s': Math.round(r.requests.average),
    'p50 ms': r.latency.p50,
    'p97.5 ms': r.latency.p97_5,
    'p99 ms': r.latency.p99,
    'max ms': r.latency.max,
    errors: r.errors + r.non2xx,
  });
}
console.table(rows);

// ---- socket throughput: many friends message the hub at once --------------------------------------------
const friends = (
  await pg.query(
    `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS id FROM friendships
      WHERE user_a = $1 OR user_b = $1 LIMIT $2`,
    [hub.id, SOCKET_SENDERS],
  )
).rows.map((r) => r.id);

const authHeaders = (uid) => ({ 'content-type': 'application/json', authorization: `Bearer ${sign(uid)}` });
const convs = [];
for (const fid of friends) {
  const r = await fetch(`${API}/v1/conversations`, {
    method: 'POST',
    headers: authHeaders(fid),
    body: JSON.stringify({ userId: hub.id }),
  });
  if (r.ok) convs.push({ uid: fid, convId: (await r.json()).id });
}

let received = 0;
const hubSock = io(API, { auth: { token }, transports: ['websocket'], reconnection: false });
await new Promise((res) => hubSock.on('connect', res));
hubSock.on('message:new', () => received++);

const senders = await Promise.all(
  convs.map(
    (c) =>
      new Promise((res) => {
        const s = io(API, { auth: { token: sign(c.uid) }, transports: ['websocket'], reconnection: false });
        s.on('connect', () => res({ ...c, s }));
      }),
  ),
);

const latencies = [];
let failed = 0;
const started = Date.now();
await Promise.all(
  senders.map(async ({ s, convId }) => {
    for (let i = 0; i < MESSAGES_EACH; i++) {
      const t0 = performance.now();
      const ack = await new Promise((res) =>
        s.emit(
          'message:send',
          { conversationId: convId, clientMsgId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, type: 'text', payload: { text: 'load' } },
          res,
        ),
      );
      if (ack?.ok) latencies.push(performance.now() - t0);
      else failed++;
    }
  }),
);
const elapsed = (Date.now() - started) / 1000;
await new Promise((r) => setTimeout(r, 1000));
latencies.sort((a, b) => a - b);

console.log(`\nsocket messages: ${senders.length} concurrent senders x ${MESSAGES_EACH}`);
console.table([
  {
    sent: latencies.length,
    failed,
    'msg/s': Math.round(latencies.length / elapsed),
    'ack p50 ms': Math.round(pct(latencies, 50)),
    'ack p95 ms': Math.round(pct(latencies, 95)),
    'ack p99 ms': Math.round(pct(latencies, 99)),
    'delivered to hub': received,
  },
]);

senders.forEach(({ s }) => s.close());
hubSock.close();
await pg.end();
process.exit(0);
