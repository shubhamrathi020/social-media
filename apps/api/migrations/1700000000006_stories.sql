-- Up Migration
-- Stories (Instagram-style ring) and statuses (WhatsApp-style, shown beside chats) share one table:
-- both are ephemeral items with a 24 hour life, an audience and a viewer list.
CREATE TABLE stories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('story', 'status')),
  media_id    uuid UNIQUE REFERENCES media(id),
  text        text CHECK (text IS NULL OR char_length(text) <= 700),
  background  text CHECK (background IS NULL OR background ~ '^#[0-9a-fA-F]{6}$'),
  audience    text NOT NULL DEFAULT 'friends' CHECK (audience IN ('friends', 'close_friends')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  deleted_at  timestamptz,
  CONSTRAINT story_has_content CHECK (media_id IS NOT NULL OR text IS NOT NULL)
);
CREATE INDEX stories_author_idx ON stories(author_id, kind, expires_at) WHERE deleted_at IS NULL;
CREATE INDEX stories_expiry_idx ON stories(expires_at);

CREATE TABLE story_views (
  story_id   uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id)
);
CREATE INDEX story_views_viewer_idx ON story_views(viewer_id, story_id);

-- Down Migration
DROP TABLE story_views;
DROP TABLE stories;
