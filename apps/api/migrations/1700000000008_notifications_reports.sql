-- Up Migration
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN
                 ('friend_request','friend_accepted','post_liked','comment','comment_reply','live_started')),
  actor_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  entity_type  text,
  entity_id    uuid,
  data         jsonb NOT NULL DEFAULT '{}',
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, seq DESC);
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;
-- One "liked your post" per person per post, however often they toggle.
CREATE UNIQUE INDEX notifications_like_dedupe ON notifications(user_id, actor_id, entity_id)
  WHERE type = 'post_liked';

CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type  text NOT NULL CHECK (entity_type IN ('user','post','comment','story')),
  entity_id    uuid NOT NULL,
  reason       text NOT NULL CHECK (reason IN
                 ('spam','harassment','nudity','violence','hate','misinformation','other')),
  details      text CHECK (details IS NULL OR char_length(details) <= 1000),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','actioned','dismissed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_id, entity_type, entity_id)
);
CREATE INDEX reports_open_idx ON reports(created_at) WHERE status = 'open';
CREATE INDEX reports_entity_idx ON reports(entity_type, entity_id);

-- Down Migration
DROP TABLE reports;
DROP TABLE notifications;
