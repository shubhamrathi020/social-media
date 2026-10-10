-- Up Migration
ALTER TABLE users
  ADD COLUMN phone_hash text GENERATED ALWAYS AS (encode(digest(phone, 'sha256'), 'hex')) STORED;
CREATE INDEX users_phone_hash_idx ON users(phone_hash);

CREATE TABLE friend_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','declined','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  responded_at  timestamptz,
  CONSTRAINT friend_requests_not_self CHECK (from_user <> to_user),
  UNIQUE (from_user, to_user)
);
CREATE INDEX friend_requests_to_idx ON friend_requests(to_user) WHERE status = 'pending';
CREATE INDEX friend_requests_from_idx ON friend_requests(from_user) WHERE status = 'pending';

-- Each friendship is stored once with user_a < user_b.
CREATE TABLE friendships (
  user_a      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CONSTRAINT friendships_ordered CHECK (user_a < user_b)
);
CREATE INDEX friendships_user_b_idx ON friendships(user_b, user_a);

-- Directional: owner curates who is on their close-friends list.
CREATE TABLE close_friends (
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, friend_id),
  CONSTRAINT close_friends_not_self CHECK (owner_id <> friend_id)
);

CREATE TABLE blocks (
  blocker_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_not_self CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks(blocked_id);

-- Hashed phone numbers uploaded by the user (opt-in) to find people they know.
CREATE TABLE contact_hashes (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash     text NOT NULL,
  PRIMARY KEY (user_id, hash)
);

CREATE TABLE suggestion_dismissals (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dismissed_id)
);

-- Down Migration
DROP TABLE suggestion_dismissals;
DROP TABLE contact_hashes;
DROP TABLE blocks;
DROP TABLE close_friends;
DROP TABLE friendships;
DROP TABLE friend_requests;
ALTER TABLE users DROP COLUMN phone_hash;
