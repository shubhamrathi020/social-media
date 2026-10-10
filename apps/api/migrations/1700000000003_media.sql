-- Up Migration
CREATE TABLE media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('image','video','audio','file')),
  purpose      text NOT NULL CHECK (purpose IN ('avatar','post','story','status','chat')),
  status       text NOT NULL DEFAULT 'uploading'
               CHECK (status IN ('uploading','processing','ready','failed')),
  mime         text NOT NULL,
  declared_size_bytes bigint NOT NULL,
  size_bytes   bigint,
  raw_key      text NOT NULL,        -- object as uploaded by the client
  storage_key  text,                 -- processed/normalised object served to viewers
  thumb_key    text,
  width        integer,
  height       integer,
  duration_ms  integer,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_owner_idx ON media(owner_id, created_at DESC);
CREATE INDEX media_stale_idx ON media(created_at) WHERE status = 'uploading';

ALTER TABLE users
  ADD CONSTRAINT users_avatar_media_fk FOREIGN KEY (avatar_media_id) REFERENCES media(id) ON DELETE SET NULL;

-- Down Migration
ALTER TABLE users DROP CONSTRAINT users_avatar_media_fk;
DROP TABLE media;
