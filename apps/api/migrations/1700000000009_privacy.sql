-- Up Migration

-- Hard-deleting an account must not be blocked by its messages or the groups it created.
ALTER TABLE conversations ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE conversations DROP CONSTRAINT conversations_created_by_fkey;
ALTER TABLE conversations ADD CONSTRAINT conversations_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE messages DROP CONSTRAINT messages_sender_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE;

-- Contact matching: replace the unsalted SHA-256 of the phone number (brute-forceable, the number space is small)
-- with an HMAC keyed by a server-side pepper. Uploaded contact hashes were made the old way, so they are dropped;
-- clients re-sync and the server computes the new ones.
ALTER TABLE users DROP COLUMN phone_hash;
ALTER TABLE users ADD COLUMN phone_hmac text;
CREATE INDEX users_phone_hmac_idx ON users(phone_hmac) WHERE phone_hmac IS NOT NULL;
TRUNCATE contact_hashes;

-- Down Migration
DROP INDEX users_phone_hmac_idx;
ALTER TABLE users DROP COLUMN phone_hmac;
ALTER TABLE users
  ADD COLUMN phone_hash text GENERATED ALWAYS AS (encode(digest(phone, 'sha256'), 'hex')) STORED;
CREATE INDEX users_phone_hash_idx ON users(phone_hash);

ALTER TABLE messages DROP CONSTRAINT messages_sender_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id);

ALTER TABLE conversations DROP CONSTRAINT conversations_created_by_fkey;
ALTER TABLE conversations ADD CONSTRAINT conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
