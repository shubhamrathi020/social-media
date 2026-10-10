# API and Real-time Events

Base: `/v1`. JSON, `Authorization: Bearer <access_token>`. Cursor (keyset) pagination: `?cursor=&limit=`.
Errors: `{ "error": { "code": "STRING_CODE", "message": "..." } }`.

## 1. REST endpoints

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | /auth/otp/request | `{phone}` |
| POST | /auth/otp/verify | returns access + refresh, creates user if new |
| POST | /auth/refresh | rotation + reuse detection |
| POST | /auth/logout | revoke session |
| GET/DELETE | /auth/sessions[/:id] | manage devices |

### Users and settings
| GET | /users/me | |
| PATCH | /users/me | name, bio, username, avatar, is_private |
| GET | /users/:id, /users/search?q= | |
| GET/PATCH | /settings | privacy, notifications, media, theme, language |
| DELETE | /users/me | account deletion |

### Friends
| POST | /friends/requests | `{to_user}` |
| GET | /friends/requests?direction=in\|out | |
| POST | /friends/requests/:id/accept \| decline \| cancel | |
| GET | /friends | list |
| DELETE | /friends/:userId | unfriend |
| GET/PUT/DELETE | /close-friends[/:userId] | manage list |
| POST/DELETE | /blocks/:userId | |
| GET | /friends/suggestions | |
| POST | /friends/suggestions/:userId/dismiss | |
| POST | /contacts/sync | hashed numbers, opt-in |

### Chat
| GET | /conversations | |
| POST | /conversations | direct (by user) or group |
| GET | /conversations/:id/messages?cursor= | history |
| POST | /conversations/:id/messages | HTTP fallback; socket preferred |
| POST | /conversations/:id/read | `{up_to_message_id}` |
| DELETE | /messages/:id?scope=me\|everyone | |
| POST/PATCH/DELETE | /conversations/:id/members | group admin |

### Media
| POST | /media/uploads | returns presigned URL(s) |
| POST | /media/:id/complete | triggers processing |
| GET | /media/:id | status + URLs |

### Posts
| POST | /posts | `{caption, audience, media_ids[1..5]}` |
| GET | /feed | |
| GET | /users/:id/posts | |
| GET/DELETE | /posts/:id | |
| PUT/DELETE | /posts/:id/like | idempotent |
| GET/POST | /posts/:id/comments | |
| DELETE | /comments/:id | |
| PUT/DELETE | /comments/:id/like | |

### Stories and statuses
| POST | /stories | `{media_id, audience}` |
| GET | /stories/feed | active stories grouped by author |
| POST | /stories/:id/view | |
| GET | /stories/:id/viewers | author only |
| POST/GET/DELETE | /statuses | |

### Live
| POST | /live | create, returns host token |
| POST | /live/:id/end | |
| GET | /live/:id | info + viewer token |
| GET | /live | currently live friends |

### Notifications
| GET | /notifications | |
| POST | /notifications/read | |
| PUT | /devices/me | register push token |

## 2. Socket.IO events

Connect with `auth: { token }`. Server auto-joins `user:{id}` and the user's conversations.

### Client to server
| Event | Payload | Ack |
|---|---|---|
| `message:send` | `{conversation_id, client_msg_id, type, payload, reply_to_id?}` | `{message_id, created_at}` |
| `message:delivered` | `{message_ids[]}` | |
| `message:read` | `{conversation_id, up_to_message_id}` | |
| `typing:start` / `typing:stop` | `{conversation_id}` | |
| `post:subscribe` / `post:unsubscribe` | `{post_id}` | |
| `post:like` / `post:unlike` | `{post_id}` | `{like_count}` |
| `live:join` / `live:leave` | `{live_id}` | |
| `live:chat` | `{live_id, text}` | |
| `live:heart` | `{live_id}` | |
| `sync:since` | `{cursor}` | missed events |

### Server to client
| Event | Payload |
|---|---|
| `message:new` | full message |
| `message:status` | `{message_id, user_id, status}` |
| `message:deleted` | `{message_id, scope}` |
| `typing` | `{conversation_id, user_id, is_typing}` |
| `presence` | `{user_id, online, last_seen_at}` |
| `post:counters` | `{post_id, like_count, comment_count}` |
| `comment:new` | comment |
| `friend:request` / `friend:accepted` | request / friendship |
| `story:new` | `{author_id, story_id}` |
| `live:started` / `live:ended` | stream info |
| `live:viewers` | `{live_id, count}` |
| `live:chat` / `live:heart` | message / burst |
| `notification:new` | notification |

## 3. Rules
- All write events are idempotent (`client_msg_id`, PUT-style like).
- Authorisation checked per event: membership for chat, friendship/audience for stories and posts, block lists everywhere.
- Rate limits: messages 30/10s per user, likes 60/min, friend requests 50/day.
- Version event names by additive change; breaking changes go to `/v2` and a new namespace.

## 4. As implemented (Phase 4)

- **Socket auth:** `io(url, { auth: { token } })` with the access token; invalid or expired tokens fail the handshake
  with `unauthorized`. Every user joins a personal room; events go to member rooms, so there is no room bookkeeping.
- **Acks:** every client event is acknowledged as `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
- **Client to server:** `message:send`, `message:delivered {messageIds[]}`, `message:read {conversationId, upToMessageId}`,
  `typing:start|stop {conversationId}`, `presence:get {userIds[]}`.
- **Server to client:** `message:new`, `message:status {messageId, conversationId, userId, status}`,
  `conversation:read {conversationId, userId, upToMessageId}`, `message:deleted`, `conversation:new`, `typing`, `presence`.
- **Message ids** are strings of a global bigint sequence; they order messages and serve as sync cursors.
- **Offline catch-up:** `GET /chat/sync?after=<id>` returns messages addressed to the user after a cursor.
- **Delete:** `DELETE /messages/:id?scope=me|everyone` (everyone: own messages, within 48 h).
- **Who can start a chat** follows the target's `privacy.messages` setting (default `friends`); blocks stop all messaging.
- **Not yet built:** group member management (add/remove/admin), mute, reply UI, push notifications for offline users.

## 5. As implemented (Phase 5)

- **Posts:** `POST /posts {caption?, audience, mediaIds[1..5]}`, `GET /posts/:id`, `PATCH /posts/:id`, `DELETE /posts/:id`,
  `GET /feed?cursor=&limit=`, `GET /users/:id/posts`. Lists return `{ items, nextCursor }` (keyset on a monotonic `seq`).
- **Reactions (like / dislike):** `PUT /posts/:id/reaction {value: 1 | -1}`, `DELETE /posts/:id/reaction`. One reaction per
  user; switching moves the counts. Dislike totals are only returned to the post's author, viewers get `myReaction`.
  Same shape for comments under `/comments/:id/reaction`.
- **Comments:** `POST|GET /posts/:id/comments` (top level newest first; `?parentId=` lists replies oldest first; one level
  of replies), `DELETE /comments/:id` (comment author or post author). Comments by users you have a block with are hidden.
- **Visibility:** author always; friends see `public`/`friends`; `close_friends` needs the author's close-friends list;
  non-friends see `public` unless the author's account is private; blocks hide everything. Enforced in one SQL predicate
  shared by feed, profile, single post, comments and subscriptions. Posts you may not see answer 404.
- **Slides:** 1-5 slides, validated in the API and by a DB check on `position`; a media item can belong to one post only.
- **Realtime:** `post:subscribe|unsubscribe {postId}`, `post:react {postId, value|null}`; server pushes `post:counters`,
  `comment:new`, `comment:deleted` to subscribers.
- **Feed** is computed at query time. Fan-out-on-write and ranking are later optimisations.

## 6. As implemented (Phase 6)

- **One table, two kinds.** Stories (media required, ring on avatars) and statuses (text with colour, or media) are rows of
  `stories` with `kind = story | status`; both live 24 hours (`expires_at`), have an audience (`friends` or
  `close_friends`) and a viewer list.
- **Endpoints:** `POST /stories`, `GET /stories/feed`, `POST /statuses`, `GET /statuses/feed`, `POST /stories/:id/view`,
  `GET /stories/:id/viewers` (author only), `POST /stories/:id/reply`, `DELETE /stories/:id`.
- **Feed shape:** items grouped by author; own group first, then groups with unseen items. Own items include `viewCount`.
- **Replies and reactions** are sent as a DM to the author with `payload.storyId` for context.
- **Visibility:** block either way hides; `privacy.stories` of `nobody` hides from everyone but the author, `friends`
  (default) is friends only, `everyone` also allows non-friends unless the account is private. `close_friends` items need
  the author's list. Expired or deleted items vanish immediately through the query predicate.
- **Realtime:** `story:new` / `status:new {authorId, itemId}` go to exactly the people allowed to see the item.
- **Cleanup:** a BullMQ job scheduler (every 10 min, `MAINTENANCE_INTERVAL_MS`) purges stories an hour after expiry, posts
  deleted over 7 days ago, and abandoned or rejected uploads older than 24 hours, removing the stored objects too.

## 7. As implemented (Phase 7)

- **Media server:** LiveKit (WebRTC SFU) from `infra/docker-compose.yml`. Our API never touches video; it mints
  short-lived room tokens and keeps the product rules (who may watch) in one place.
- **REST:** `POST /live {title, audience}` (host token + room), `POST /live/:id/start` (marks live and notifies the
  audience), `POST /live/:id/end`, `POST /live/:id/join` (viewer token, viewer count, recent chat), `GET /live`
  (friends live now), `POST /live/webhook` (LiveKit, signature verified).
- **Tokens:** host can publish; viewers can only subscribe and receive data. A viewer token cannot publish.
- **Audience:** `friends` or `close_friends`; blocks hide; one unfinished stream per host (DB unique index).
- **Socket:** `live:join|leave {liveId}`, `live:chat {liveId, text}` (1/s), `live:heart {liveId}` (8/s). Server pushes
  `live:started`, `live:ended`, `live:viewers {count}`, `live:chat`, `live:heart {total}`. Viewer count is distinct people
  in the live room, excluding the host. Chat history (last 50) lives in Redis and is dropped when the stream ends.
- **Robustness:** a LiveKit `room_finished` webhook ends streams whose host disappeared without calling `/end`.
- **Mobile:** requires an Expo **development build** (`expo-dev-client`), because WebRTC is a native module. The live
  screens load it lazily so every other screen still works in Expo Go.

## 8. As implemented (Phase 8)

- **Domain events:** friends, posts, comments, live and chat emit in-process events (`friend.request`, `friend.accepted`,
  `post.liked`, `comment.created`, `live.started`, `message.created`); the notifications module listens, so those modules
  know nothing about notifications.
- **Inbox:** `GET /notifications?cursor=`, `GET /notifications/unread-count`, `POST /notifications/read {ids?}`. Types:
  `friend_request`, `friend_accepted`, `post_liked`, `comment`, `comment_reply`, `live_started`. Likes dedupe to one per
  person per post; own actions and dislikes never notify. Live delivery as `notification:new` over the socket.
- **Preferences:** `settings.notifications.*` decide what is created and pushed. Muted conversations get no message push.
- **Push:** `PUT /devices/me {pushToken|null}` stores an Expo push token on the session's device. Messages are pushed only
  to people with no live socket. Logging out clears the device token; tokens the push service reports invalid are dropped.
  `PUSH_MODE=expo` sends for real (default in production); otherwise pushes are logged.
- **Reports:** `POST /reports {entityType: user|post|comment|story, entityId, reason, details?}`. You can only report what
  you can see; repeat reports are idempotent; 20 per day. There is no moderator UI yet: reports sit in `reports`.
- **Rate limiting:** every route is limited per user (600/min) or per IP when unauthenticated (120/min), with stricter
  per-route limits (`@RateLimit`). Responses carry `X-RateLimit-*` and `Retry-After`.
- **Hardening:** `helmet` headers, `TRUST_PROXY` for real client IPs behind a load balancer, and a boot-time config check
  that refuses placeholder secrets and `OTP_DEV_CODE` in production.
