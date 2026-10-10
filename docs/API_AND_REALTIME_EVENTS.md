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
