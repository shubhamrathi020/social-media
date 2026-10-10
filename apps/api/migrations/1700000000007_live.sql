-- Up Migration
CREATE TABLE live_streams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL DEFAULT '' CHECK (char_length(title) <= 100),
  audience      text NOT NULL DEFAULT 'friends' CHECK (audience IN ('friends', 'close_friends')),
  status        text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'live', 'ended')),
  room_name     text NOT NULL UNIQUE,
  peak_viewers  integer NOT NULL DEFAULT 0,
  heart_count   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  ended_at      timestamptz
);
CREATE INDEX live_streams_live_idx ON live_streams(status) WHERE status <> 'ended';
-- A host can only have one unfinished stream at a time.
CREATE UNIQUE INDEX live_streams_one_active_per_host ON live_streams(host_id) WHERE status <> 'ended';

-- Down Migration
DROP TABLE live_streams;
