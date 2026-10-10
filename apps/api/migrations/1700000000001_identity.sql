-- Up Migration
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL UNIQUE,
  username      text UNIQUE,
  display_name  text,
  bio           text NOT NULL DEFAULT '',
  avatar_media_id uuid,
  is_private    boolean NOT NULL DEFAULT false,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  CONSTRAINT username_format CHECK (username IS NULL OR username ~ '^[a-z0-9_.]{3,30}$')
);
CREATE INDEX users_username_trgm ON users USING gin (username gin_trgm_ops);
CREATE INDEX users_display_name_trgm ON users USING gin (display_name gin_trgm_ops);

CREATE TABLE devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform            text NOT NULL CHECK (platform IN ('ios','android','web')),
  push_token          text,
  public_identity_key bytea,
  last_active_at      timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON devices(user_id);

CREATE TABLE sessions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id                uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  refresh_token_hash       text NOT NULL,
  prev_refresh_token_hash  text,
  expires_at               timestamptz NOT NULL,
  revoked_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  last_used_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE user_settings (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  privacy       jsonb NOT NULL DEFAULT '{"messages":"friends","lastSeen":"friends","stories":"friends"}',
  notifications jsonb NOT NULL DEFAULT '{"messages":true,"friendRequests":true,"likes":true,"comments":true,"live":true}',
  media         jsonb NOT NULL DEFAULT '{"dataSaver":false,"autoplay":true}',
  language      text NOT NULL DEFAULT 'en',
  theme         text NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE user_settings;
DROP TABLE sessions;
DROP TABLE devices;
DROP TABLE users;
