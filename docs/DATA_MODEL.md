# Data Model (PostgreSQL)

Conventions: `uuid` primary keys (UUIDv7 preferred for index locality), `timestamptz` everywhere,
`created_at`/`updated_at`, soft delete via `deleted_at` where users expect "undo". Names are indicative;
finalise in migrations.

## 1. Identity
```
users(id, phone UNIQUE, username UNIQUE, display_name, bio, avatar_media_id,
      is_private, last_seen_at, created_at, deleted_at)
devices(id, user_id, platform, push_token, public_identity_key NULL, last_active_at)   -- E2E-ready
sessions(id, user_id, device_id, refresh_token_hash, expires_at, revoked_at)
user_settings(user_id PK, privacy jsonb, notifications jsonb, media jsonb, language, theme)
```

## 2. Social graph
```
friend_requests(id, from_user, to_user, status[pending|accepted|declined|cancelled],
                created_at, responded_at, UNIQUE(from_user, to_user))

friendships(user_a, user_b, created_at,            -- stored once, CHECK (user_a < user_b)
            PRIMARY KEY(user_a, user_b))
-- index (user_b, user_a) so lookups work from either side

close_friends(owner_id, friend_id, created_at,     -- directional, owner curates
              PRIMARY KEY(owner_id, friend_id))
-- app invariant: friend_id must be a friend of owner_id

blocks(blocker_id, blocked_id, created_at, PRIMARY KEY(blocker_id, blocked_id))

contact_hashes(user_id, hash, PRIMARY KEY(user_id, hash))   -- hashed phone numbers, opt-in
friend_suggestions(user_id, suggested_id, score, reason[mutual|contact], mutual_count,
                   dismissed_at, computed_at, PRIMARY KEY(user_id, suggested_id))
```
Suggestion query shape (friends of friends not yet friends, not blocked):
```sql
SELECT f2.friend AS candidate, COUNT(*) AS mutual
FROM   friend_edges f1                    -- view/union of both directions of friendships
JOIN   friend_edges f2 ON f2.user = f1.friend
WHERE  f1.user = :me AND f2.friend <> :me
  AND  f2.friend NOT IN (SELECT friend FROM friend_edges WHERE user = :me)
GROUP  BY f2.friend ORDER BY mutual DESC LIMIT 50;
```

## 3. Media
```
media(id, owner_id, kind[image|video|audio|file], status[uploading|processing|ready|failed],
      storage_key, hls_key NULL, thumb_key NULL, width, height, duration_ms, size_bytes, created_at)
```

## 4. Posts
```
posts(id, author_id, caption, audience[public|friends|close_friends],
      like_count, comment_count, created_at, deleted_at)
post_slides(post_id, position SMALLINT CHECK (position BETWEEN 1 AND 5), media_id,
            PRIMARY KEY(post_id, position))             -- DB-level 5-slide cap
post_likes(post_id, user_id, created_at, PRIMARY KEY(post_id, user_id))
comments(id, post_id, user_id, parent_id NULL, body, like_count, created_at, deleted_at)
comment_likes(comment_id, user_id, PRIMARY KEY(comment_id, user_id))
```
Feed v1: query-time (`posts WHERE author IN friends ORDER BY created_at DESC`, keyset pagination).
Fan-out-on-write into Redis feed lists is a later optimisation.

## 5. Stories and statuses
```
stories(id, author_id, media_id, audience[friends|close_friends], overlay jsonb,
        created_at, expires_at)                          -- index (author_id, expires_at)
story_views(story_id, viewer_id, viewed_at, PRIMARY KEY(story_id, viewer_id))
statuses(id, author_id, kind[text|media], text, media_id NULL, created_at, expires_at)
```
Expired rows are hidden by `expires_at > now()` and purged by a scheduled job.

## 6. Chat
```
conversations(id, type[direct|group], title NULL, avatar_media_id NULL, created_by,
              last_message_id, last_message_at, direct_key UNIQUE NULL)   -- direct_key = sorted user pair
conversation_members(conversation_id, user_id, role[member|admin], joined_at,
                     last_read_message_id, muted_until, PRIMARY KEY(conversation_id, user_id))
messages(id, conversation_id, sender_id, sender_device_id NULL, client_msg_id,
         type[text|image|video|audio|file|system],
         payload bytea,            -- plaintext JSON now, ciphertext later
         enc_version SMALLINT DEFAULT 0,
         reply_to_id NULL, created_at, deleted_at,
         UNIQUE(conversation_id, sender_id, client_msg_id))     -- idempotency
message_receipts(message_id, user_id, delivered_at, read_at, PRIMARY KEY(message_id, user_id))
```
Index `messages(conversation_id, id DESC)`; partition by time later if large.

## 7. Live and notifications
```
live_streams(id, host_id, title, status[scheduled|live|ended], livekit_room, started_at, ended_at,
             peak_viewers)
notifications(id, user_id, type, actor_id, entity_type, entity_id, data jsonb, read_at, created_at)
push_tokens -> covered by devices.push_token
reports(id, reporter_id, entity_type, entity_id, reason, status, created_at)
```

## 8. Redis keys
| Key | Purpose |
|---|---|
| `presence:{userId}` (TTL) | online state |
| `post:{id}:likes` | live like counter |
| `suggest:{userId}` | cached suggestion ids |
| `rate:{ip|user}:{route}` | rate limiting |
| `bull:*` | job queues |

## 9. E2E-ready additions (create tables now, populate later)
```
identity_keys(device_id PK, identity_public, signed_prekey, signed_prekey_sig, created_at)
one_time_prekeys(id, device_id, public_key, used_at)
```
