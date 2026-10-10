-- Up Migration
CREATE TABLE posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,   -- keyset pagination cursor
  author_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption        text NOT NULL DEFAULT '' CHECK (char_length(caption) <= 2200),
  audience       text NOT NULL DEFAULT 'friends' CHECK (audience IN ('public','friends','close_friends')),
  like_count     integer NOT NULL DEFAULT 0,
  dislike_count  integer NOT NULL DEFAULT 0,
  comment_count  integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX posts_author_idx ON posts(author_id, seq DESC) WHERE deleted_at IS NULL;

-- At most 5 slides per post, enforced by the database and not only by the API.
CREATE TABLE post_slides (
  post_id   uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  position  smallint NOT NULL CHECK (position BETWEEN 1 AND 5),
  media_id  uuid NOT NULL UNIQUE REFERENCES media(id),
  PRIMARY KEY (post_id, position)
);

CREATE TABLE post_reactions (
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value       smallint NOT NULL CHECK (value IN (1, -1)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX post_reactions_user_idx ON post_reactions(user_id, post_id);

CREATE TABLE comments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  post_id        uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id      uuid REFERENCES comments(id) ON DELETE CASCADE,
  body           text NOT NULL CHECK (char_length(body) <= 1000),  -- '' for deleted tombstones
  like_count     integer NOT NULL DEFAULT 0,
  dislike_count  integer NOT NULL DEFAULT 0,
  reply_count    integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX comments_post_idx ON comments(post_id, seq DESC) WHERE parent_id IS NULL;
CREATE INDEX comments_parent_idx ON comments(parent_id, seq ASC) WHERE parent_id IS NOT NULL;

CREATE TABLE comment_reactions (
  comment_id  uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value       smallint NOT NULL CHECK (value IN (1, -1)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

-- Down Migration
DROP TABLE comment_reactions;
DROP TABLE comments;
DROP TABLE post_reactions;
DROP TABLE post_slides;
DROP TABLE posts;
