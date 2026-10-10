-- Up Migration
CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN ('direct','group')),
  title            text,
  avatar_media_id  uuid REFERENCES media(id) ON DELETE SET NULL,
  created_by       uuid NOT NULL REFERENCES users(id),
  direct_key       text UNIQUE,            -- "<smaller user id>:<larger user id>" for direct chats
  last_message_id  bigint,
  last_message_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT direct_has_key CHECK ((type = 'direct') = (direct_key IS NOT NULL))
);
CREATE INDEX conversations_last_message_idx ON conversations(last_message_at DESC NULLS LAST);

CREATE TABLE conversation_members (
  conversation_id       uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  text NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
  joined_at             timestamptz NOT NULL DEFAULT now(),
  last_read_message_id  bigint NOT NULL DEFAULT 0,
  muted_until           timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members(user_id);

-- bigint identity gives a global monotonic order used for pagination and offline sync.
CREATE TABLE messages (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        uuid NOT NULL REFERENCES users(id),
  sender_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  client_msg_id    text NOT NULL,
  type             text NOT NULL CHECK (type IN ('text','image','video','audio','file','system')),
  payload          bytea NOT NULL,          -- UTF-8 JSON while enc_version = 0; ciphertext after E2E
  enc_version      smallint NOT NULL DEFAULT 0,
  reply_to_id      bigint REFERENCES messages(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (conversation_id, sender_id, client_msg_id)
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, id DESC);

CREATE TABLE message_receipts (
  message_id    bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at  timestamptz,
  read_at       timestamptz,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_receipts_user_idx ON message_receipts(user_id, message_id);

-- "Delete for me"
CREATE TABLE message_hidden (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, message_id)
);

-- Down Migration
DROP TABLE message_hidden;
DROP TABLE message_receipts;
DROP TABLE messages;
DROP TABLE conversation_members;
DROP TABLE conversations;
