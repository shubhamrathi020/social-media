// End-to-end moderation check.
// Needs the API running with OTP_DEV_CODE=123456, CONTENT_SCAN=test-colour and AUTO_HIDE_REPORTS=3,
// plus DATABASE_URL to grant moderator rights. With the test scanner, "redness" stands in for explicitness.
import { createRequire } from 'node:module';

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
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
async function signup(label) {
  const phone = '+1415' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
  await call('POST', '/auth/otp/request', null, { phone });
  const r = await call('POST', '/auth/otp/verify', null, { phone, code: CODE, device: { platform: 'android' } });
  await call('PATCH', '/users/me', r.data.accessToken, { displayName: label });
  return { id: r.data.userId, token: r.data.accessToken, refresh: r.data.refreshToken, phone, label };
}
async function befriend(a, b) {
  const r = await call('POST', '/friends/requests', a.token, { toUser: b.id });
  await call('POST', `/friends/requests/${r.data.id}/accept`, b.token);
}
async function upload(user, purpose, rgb) {
  const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: rgb } }).png().toBuffer();
  const up = await call('POST', '/media/uploads', user.token, { kind: 'image', purpose, mime: 'image/png', sizeBytes: png.length });
  await fetch(up.data.upload.url, { method: 'PUT', headers: up.data.upload.headers, body: png });
  await call('POST', `/media/${up.data.id}/complete`, user.token);
  for (let i = 0; i < 80; i++) {
    const m = await call('GET', `/media/${up.data.id}`, user.token);
    if (m.data.status === 'ready' || m.data.status === 'failed') return m.data;
    await sleep(250);
  }
  return { status: 'timeout' };
}
const GREY = { r: 120, g: 120, b: 120 };
const BORDERLINE = { r: 220, g: 50, b: 50 }; // score ~0.67: held for review
const EXPLICIT = { r: 255, g: 0, b: 0 }; // score 1.0: rejected

const mod = await signup('mod');
const author = await signup('author');
const [f1, f2, f3] = await Promise.all(['f1', 'f2', 'f3'].map(signup));
const outsider = await signup('outsider');
for (const f of [f1, f2, f3]) await befriend(author, f);

const pg = new Client({ connectionString: DB });
await pg.connect();
await pg.query('UPDATE users SET is_admin = true WHERE id = $1', [mod.id]);

// --- admin access
let r = await call('GET', '/admin/queue', author.token);
check('non-moderators are refused -> 403', r.status === 403);
r = await call('GET', '/admin/queue');
check('anonymous is refused -> 401', r.status === 401);
r = await call('GET', '/admin');
check('moderator page is served with its own CSP', r.status === 200 && /Moderation/.test(r.data) &&
  /img-src[^;]*https:/.test(r.headers.get('content-security-policy') ?? ''));
const scriptSrc = /<script src="([^"]+)"/.exec(r.data)?.[1];
const scriptUrl = new URL(scriptSrc ?? 'missing', HTTP.replace(/\/v1$/, '') + '/v1/admin').toString();
const js = await fetch(scriptUrl);
check('the page references a script URL that resolves', js.status === 200 && /javascript/.test(js.headers.get('content-type') ?? ''), scriptUrl);

// --- image scanning
let m = await upload(author, 'post', EXPLICIT);
check('clearly explicit upload is rejected', m.status === 'failed' && /not allowed/.test(m.error ?? ''), JSON.stringify(m));
m = await upload(author, 'avatar', EXPLICIT);
check('explicit avatar is rejected too', m.status === 'failed');
const ok = await upload(author, 'post', GREY);
check('ordinary upload passes', ok.status === 'ready');
const border = await upload(author, 'post', BORDERLINE);
check('borderline upload is accepted for now', border.status === 'ready');

r = await call('POST', '/posts', author.token, { caption: 'borderline', audience: 'friends', mediaIds: [border.id] });
const flagged = r.data.id;
r = await call('GET', `/posts/${flagged}`, author.token);
check('author still sees a post held for review', r.status === 200);
r = await call('GET', `/posts/${flagged}`, f1.token);
check('friends do not see a post held for review -> 404', r.status === 404);
r = await call('GET', '/feed', f1.token);
check('held post is not in the feed', r.data.items.every((p) => p.id !== flagged));

// --- report threshold
r = await call('POST', '/posts', author.token, { caption: 'normal post', audience: 'friends', mediaIds: [ok.id] });
const post = r.data.id;
await call('POST', '/reports', f1.token, { entityType: 'post', entityId: post, reason: 'spam' });
await call('POST', '/reports', f2.token, { entityType: 'post', entityId: post, reason: 'harassment', details: 'mean' });
r = await call('GET', `/posts/${post}`, f3.token);
check('two reports do not hide a post', r.status === 200);
await call('POST', '/reports', f3.token, { entityType: 'post', entityId: post, reason: 'spam' });
r = await call('GET', `/posts/${post}`, outsider.token);
r = await call('GET', `/posts/${post}`, f1.token);
check('three reporters hide it pending review', r.status === 404);
r = await call('GET', `/posts/${post}`, author.token);
check('author still sees it', r.status === 200);

// --- queue
r = await call('GET', '/admin/queue', mod.token);
const qPost = r.data.find((x) => x.entityId === post);
const qFlag = r.data.find((x) => x.entityId === flagged);
check('reported post is queued with 3 reporters', qPost?.reporters === 3 && qPost.reasons.includes('spam') && qPost.preview?.hiddenAt, JSON.stringify(qPost));
check('scanner-flagged post is queued as a system report', qFlag?.flaggedBySystem === true && qFlag.preview?.media?.[0]?.thumbUrl);
check('reporter notes are shown', qPost?.details?.includes('mean'));

// --- decisions
r = await call('POST', '/admin/decisions', mod.token, { entityType: 'post', entityId: post, decision: 'dismiss', note: 'fine' });
check('dismiss', r.status === 200);
r = await call('GET', `/posts/${post}`, f1.token);
check('dismissed post is visible again', r.status === 200);
r = await call('POST', '/admin/decisions', mod.token, { entityType: 'post', entityId: flagged, decision: 'remove' });
check('remove', r.status === 200);
r = await call('GET', `/posts/${flagged}`, author.token);
check('removed post is gone for the author too', r.status === 404);
r = await call('GET', '/admin/queue', mod.token);
check('decided items leave the open queue', r.data.every((x) => x.entityId !== post && x.entityId !== flagged));
r = await call('GET', '/admin/queue?status=closed', mod.token);
check('and appear in the closed list', r.data.some((x) => x.entityId === post) && r.data.some((x) => x.entityId === flagged));

// --- comments
r = await call('POST', `/posts/${post}/comments`, outsider.token, { body: 'x' });
r = await call('POST', `/posts/${post}/comments`, f1.token, { body: 'rude comment' });
const comment = r.data.id;
const before = (await call('GET', `/posts/${post}`, author.token)).data.commentCount;
for (const u of [author, f2, f3]) await call('POST', '/reports', u.token, { entityType: 'comment', entityId: comment, reason: 'harassment' });
r = await call('GET', `/posts/${post}/comments`, f2.token);
check('reported comment hidden from others', r.data.items.every((c) => c.id !== comment));
r = await call('GET', `/posts/${post}/comments`, f1.token);
check('comment author still sees it', r.data.items.some((c) => c.id === comment));
await call('POST', '/admin/decisions', mod.token, { entityType: 'comment', entityId: comment, decision: 'remove' });
r = await call('GET', `/posts/${post}`, author.token);
check('removing a comment updates the count', r.data.commentCount === before - 1, `${before} -> ${r.data.commentCount}`);

// --- suspension
const story = await upload(author, 'story', GREY);
r = await call('POST', '/stories', author.token, { mediaId: story.id });
const storyId = r.data.id;
await call('POST', '/reports', f1.token, { entityType: 'story', entityId: storyId, reason: 'hate' });
r = await call('POST', '/admin/decisions', mod.token, { entityType: 'story', entityId: storyId, decision: 'suspend_author', note: 'repeat' });
check('remove story and suspend its author', r.status === 200);
r = await call('POST', '/auth/refresh', null, { refreshToken: author.refresh });
check('suspended account cannot refresh', r.status === 401);
await call('POST', '/auth/otp/request', null, { phone: author.phone });
await sleep(31_000); // the sign-up code started the resend cooldown
await call('POST', '/auth/otp/request', null, { phone: author.phone });
r = await call('POST', '/auth/otp/verify', null, { phone: author.phone, code: CODE, device: { platform: 'android' } });
check('suspended account cannot sign in -> 403', r.status === 403, JSON.stringify(r.data));
r = await call('POST', `/admin/users/${author.id}/unsuspend`, mod.token, { note: 'appeal accepted' });
check('unsuspend', r.status === 204);
await sleep(31_000);
await call('POST', '/auth/otp/request', null, { phone: author.phone });
r = await call('POST', '/auth/otp/verify', null, { phone: author.phone, code: CODE, device: { platform: 'android' } });
check('unsuspended account can sign in again', r.status === 200);
r = await call('POST', `/admin/users/${mod.id}/suspend`, mod.token, {});
check('moderators cannot suspend themselves', r.status === 403);

// --- audit log
r = await call('GET', '/admin/actions', mod.token);
const acts = r.data.map((a) => a.action);
check('moderator actions are attributed to the moderator', r.data.filter((a) => a.action === 'dismiss' && a.entityId === post).every((a) => a.moderator === 'mod'), JSON.stringify(r.data.filter((a) => a.action === 'dismiss')));
check('audit log records every action', ['dismiss', 'remove', 'suspend', 'unsuspend', 'auto_hide'].every((a) => acts.includes(a)), JSON.stringify(acts));

await pg.query('UPDATE users SET is_admin = false WHERE id = $1', [mod.id]);
r = await call('GET', '/admin/queue', mod.token);
check('revoking moderator rights takes effect immediately', r.status === 403);
await pg.end();

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
