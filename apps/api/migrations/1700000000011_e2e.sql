-- Up Migration
-- Conversations created when every member has an encryption-capable device are end-to-end encrypted. The server
-- then only ever stores ciphertext for their messages (enc_version = 1) and one sealed message key per device.
ALTER TABLE conversations ADD COLUMN e2e boolean NOT NULL DEFAULT false;

CREATE TABLE message_keys (
  message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  device_id   uuid   NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  box         bytea  NOT NULL,       -- nonce || box(message key) for this device
  PRIMARY KEY (message_id, device_id)
);
CREATE INDEX message_keys_device_idx ON message_keys(device_id, message_id);

-- Encrypted attachments: the server stores an opaque blob and only needs to know which upload to serve.
ALTER TABLE messages ADD COLUMN attachment_media_id uuid REFERENCES media(id) ON DELETE SET NULL;

-- Down Migration
ALTER TABLE messages DROP COLUMN attachment_media_id;
DROP TABLE message_keys;
ALTER TABLE conversations DROP COLUMN e2e;
