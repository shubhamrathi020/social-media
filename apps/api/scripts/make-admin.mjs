// Grants (or with --revoke, removes) moderator rights for the account with this phone number.
//   DATABASE_URL=... node scripts/make-admin.mjs +919876543210 [--revoke]
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const [phone, flag] = process.argv.slice(2);
if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) {
  console.error('usage: node scripts/make-admin.mjs <E.164 phone> [--revoke]');
  process.exit(1);
}
const pg = new Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://social:social@localhost:5433/social' });
await pg.connect();
const r = await pg.query(
  'UPDATE users SET is_admin = $2 WHERE phone = $1 AND deleted_at IS NULL RETURNING id, username',
  [phone, flag !== '--revoke'],
);
await pg.end();
if (r.rowCount === 0) {
  console.error('No active account with that phone number. Sign in once in the app first.');
  process.exit(1);
}
console.log(`${flag === '--revoke' ? 'Revoked' : 'Granted'} moderator rights for ${r.rows[0].username ?? r.rows[0].id}`);
