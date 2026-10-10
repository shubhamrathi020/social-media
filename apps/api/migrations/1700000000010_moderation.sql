-- Up Migration
ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN suspended_at timestamptz;

-- hidden_at: taken out of circulation pending review (by enough reports or the image scanner).
-- The author still sees the item; a moderator either removes it (deleted_at) or restores it.
ALTER TABLE posts ADD COLUMN hidden_at timestamptz;
ALTER TABLE comments ADD COLUMN hidden_at timestamptz;
ALTER TABLE stories ADD COLUMN hidden_at timestamptz;

-- Likelihood of explicit content from the image scanner (0..1), null when not scanned.
ALTER TABLE media ADD COLUMN nsfw_score real;

-- Reports raised by the system (image scanner) have no human reporter.
ALTER TABLE reports ALTER COLUMN reporter_id DROP NOT NULL;

CREATE TABLE moderation_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moderator_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type   text NOT NULL CHECK (entity_type IN ('user','post','comment','story')),
  entity_id     uuid NOT NULL,
  action        text NOT NULL CHECK (action IN ('dismiss','remove','suspend','unsuspend','auto_hide')),
  note          text CHECK (note IS NULL OR char_length(note) <= 1000),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_entity_idx ON moderation_actions(entity_type, entity_id);

-- Down Migration
DROP TABLE moderation_actions;
DELETE FROM reports WHERE reporter_id IS NULL;
ALTER TABLE reports ALTER COLUMN reporter_id SET NOT NULL;
ALTER TABLE media DROP COLUMN nsfw_score;
ALTER TABLE stories DROP COLUMN hidden_at;
ALTER TABLE comments DROP COLUMN hidden_at;
ALTER TABLE posts DROP COLUMN hidden_at;
ALTER TABLE users DROP COLUMN suspended_at;
ALTER TABLE users DROP COLUMN is_admin;
