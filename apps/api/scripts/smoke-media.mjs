// End-to-end media check. Requires the API, Postgres, Redis and S3 to be running.
// Run from apps/api:  OTP_DEV_CODE=123456 node dist/main.js   then   node scripts/smoke-media.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const ffmpeg = require('ffmpeg-static');

const B = process.env.API_URL ?? 'http://localhost:3000/v1';
const CODE = process.env.OTP_DEV_CODE ?? '123456';
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

async function signup() {
  const phone = '+1415' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
  await call('POST', '/auth/otp/request', null, { phone });
  const r = await call('POST', '/auth/otp/verify', null, { phone, code: CODE, device: { platform: 'android' } });
  return { id: r.data.userId, token: r.data.accessToken };
}

async function upload(token, { kind, purpose, mime, bytes }) {
  const r = await call('POST', '/media/uploads', token, { kind, purpose, mime, sizeBytes: bytes.length });
  if (r.status !== 201) return { error: r };
  const put = await fetch(r.data.upload.url, { method: 'PUT', headers: r.data.upload.headers, body: bytes });
  if (!put.ok) return { error: { status: put.status, data: 'PUT failed' } };
  const done = await call('POST', `/media/${r.data.id}/complete`, token);
  return { id: r.data.id, done };
}

async function waitReady(token, id) {
  for (let i = 0; i < 60; i++) {
    const r = await call('GET', `/media/${id}`, token);
    if (r.data.status === 'ready' || r.data.status === 'failed') return r.data;
    await new Promise((s) => setTimeout(s, 500));
  }
  return { status: 'timeout' };
}

const me = await signup();
const other = await signup();

// --- image: 3000x2000 JPEG with EXIF (GPS-like) orientation, expect <=2048 wide, thumb, no EXIF
const jpeg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3366cc' } })
  .withMetadata({ orientation: 6 })
  .jpeg()
  .toBuffer();
let up = await upload(me.token, { kind: 'image', purpose: 'post', mime: 'image/jpeg', bytes: jpeg });
check('image upload accepted', up.done?.status === 200, JSON.stringify(up));
let m = await waitReady(me.token, up.id);
check('image becomes ready', m.status === 'ready', JSON.stringify(m));
check('image downscaled to <=2048', Math.max(m.width, m.height) <= 2048, `${m.width}x${m.height}`);
check('exif orientation applied (portrait)', m.height > m.width, `${m.width}x${m.height}`);
const main = Buffer.from(await (await fetch(m.url)).arrayBuffer());
const mainMeta = await sharp(main).metadata();
check('served image has no EXIF', !mainMeta.exif && !mainMeta.orientation, JSON.stringify(mainMeta.orientation));
const thumbRes = await fetch(m.thumbUrl);
check('thumbnail reachable', thumbRes.ok && thumbRes.headers.get('content-type') === 'image/webp');

// --- fake image (text with image mime) must be rejected by content sniffing
up = await upload(me.token, { kind: 'image', purpose: 'post', mime: 'image/png', bytes: Buffer.from('<html>not an image</html>') });
m = await waitReady(me.token, up.id);
check('non-image content rejected', m.status === 'failed', JSON.stringify(m));

// --- request-level validation
let r = await call('POST', '/media/uploads', me.token, { kind: 'image', purpose: 'post', mime: 'image/svg+xml', sizeBytes: 100 });
check('svg mime rejected -> 400', r.status === 400);
r = await call('POST', '/media/uploads', me.token, { kind: 'video', purpose: 'avatar', mime: 'video/mp4', sizeBytes: 100 });
check('video avatar rejected -> 400', r.status === 400);
r = await call('POST', '/media/uploads', null, { kind: 'image', purpose: 'post', mime: 'image/png', sizeBytes: 1 });
check('unauthenticated -> 401', r.status === 401);

// --- complete without uploading
r = await call('POST', '/media/uploads', me.token, { kind: 'image', purpose: 'post', mime: 'image/png', sizeBytes: 10 });
r = await call('POST', `/media/${r.data.id}/complete`, me.token);
check('complete before PUT -> 400', r.status === 400, JSON.stringify(r));

// --- ownership
r = await call('GET', `/media/${up.id}`, other.token);
check("cannot read another user's media -> 404", r.status === 404);

// --- video: 2s 1920x1080 test pattern
const dir = mkdtempSync(join(tmpdir(), 'smoke-'));
const vpath = join(dir, 'in.mp4');
execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vpath], { stdio: 'ignore' });
up = await upload(me.token, { kind: 'video', purpose: 'post', mime: 'video/mp4', bytes: readFileSync(vpath) });
m = await waitReady(me.token, up.id);
check('video becomes ready', m.status === 'ready', JSON.stringify(m));
check('video scaled to 1280 wide', m.width === 1280 && m.height === 720, `${m.width}x${m.height}`);
check('video duration ~2s', Math.abs(m.durationMs - 2000) < 400, String(m.durationMs));
const vres = await fetch(m.url);
check('video playable url', vres.ok && vres.headers.get('content-type') === 'video/mp4');
check('video poster reachable', (await fetch(m.thumbUrl)).ok);

// --- avatar flow
const png = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#cc3366' } }).png().toBuffer();
up = await upload(me.token, { kind: 'image', purpose: 'avatar', mime: 'image/png', bytes: png });
m = await waitReady(me.token, up.id);
r = await call('PATCH', '/users/me', me.token, { avatarMediaId: up.id });
check('set avatar', r.status === 200 && !!r.data.avatarUrl, JSON.stringify(r));
r = await call('PATCH', '/users/me', other.token, { avatarMediaId: up.id });
check("cannot use someone else's media as avatar -> 400", r.status === 400);
r = await call('PATCH', '/users/me', me.token, { avatarMediaId: null });
check('remove avatar', r.status === 200 && r.data.avatarUrl === null);

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
