# Architecture

## 1. Stack
| Layer | Choice |
|---|---|
| Mobile | React Native + Expo (TypeScript), TanStack Query, Zustand, FlashList, Reanimated, expo-video |
| Backend | NestJS (TypeScript) **modular monolith**, REST + Socket.IO gateway |
| Primary DB | PostgreSQL |
| Cache / realtime / queues | Redis (pub/sub, counters, presence, BullMQ) |
| Object storage + CDN | S3-compatible (S3 or R2) + CDN |
| Video processing | FFmpeg workers (BullMQ) producing HLS + thumbnails |
| Live streaming | LiveKit (WebRTC SFU) |
| Auth | Phone OTP provider + JWT access/refresh |
| Push | FCM + APNs via Expo Notifications |
| Repo | Turborepo monorepo: `apps/mobile`, `apps/api`, `packages/shared` |

## 2. System overview

```
 Mobile app (RN)
   |  REST (HTTPS)          |  WebSocket (Socket.IO)      |  WebRTC
   v                        v                             v
 +---------------- NestJS modular monolith ----------+   LiveKit SFU
 | auth | users | friends | chat | posts | stories   |      ^
 | live | notifications | media | settings           |------+ (token minting, webhooks)
 +--------+----------------+-------------+-----------+
          |                |             |
      PostgreSQL         Redis      S3 + CDN <--- FFmpeg workers (BullMQ)
```

## 3. Modules (bounded contexts)
Each module owns its tables, exposes a service interface, and talks to others only via that interface
or domain events. This is what makes later extraction to a service cheap.

| Module | Owns |
|---|---|
| auth | OTP, sessions, devices, tokens |
| users | profiles, privacy settings |
| friends | requests, friendships, close friends, blocks, suggestions |
| chat | conversations, members, messages, receipts |
| posts | posts, slides, likes, comments |
| stories | stories, statuses, views |
| live | streams, viewer tokens |
| notifications | push tokens, notification inbox, preferences |
| media | upload sessions, processing jobs |

Rules: no cross-module table joins in code (use service calls); cross-module side effects go through an
in-process event bus (`friend.accepted`, `post.liked`, ...), which can become Redis/Kafka later.

## 4. Real-time design
- One Socket.IO connection per device, authenticated with the access token.
- Rooms: `user:{id}` (personal events), `conv:{id}` (chat), `post:{id}` (live counters while on screen),
  `live:{id}`.
- Redis adapter so multiple API instances share rooms.
- Event catalogue in API_AND_REALTIME_EVENTS.md.
- **Instant like path:** optimistic UI, then socket emit, then Postgres write + Redis `INCR`, then broadcast to
  `post:{id}`. Postgres is source of truth; Redis counter is reconciled periodically.
- **Presence:** Redis key per user with TTL refreshed by heartbeat; last-seen persisted on disconnect.
- **Delivery guarantees:** client sends with a `client_msg_id`; server is idempotent on it; acks drive
  sent/delivered/read; on reconnect client requests "events since cursor".

## 5. Media pipeline
1. Client asks `POST /media/uploads` and receives presigned PUT URL(s).
2. Client uploads directly to S3.
3. Client calls `POST /media/{id}/complete`; a BullMQ job validates, transcodes video to HLS, creates thumbnails.
4. Media becomes `ready`; only then can a post/story reference it.
5. Delivery through CDN; private content via signed URLs.

## 6. Live streaming
- Server mints LiveKit tokens (publisher for host, subscriber for viewers).
- LiveKit webhooks update stream state (started/ended, viewer count).
- Live chat and hearts use our own Socket.IO `live:{id}` room (keeps moderation and persistence in our control).

## 7. Friends graph and suggestions
- Stored in PostgreSQL (see DATA_MODEL.md). No separate graph database in v1.
- Suggestions: friends-of-friends scored by mutual-friend count, plus phone-contact matches.
  Computed by a nightly + on-demand job into `friend_suggestions`, cached per user in Redis.
- Revisit a graph DB (Neo4j) or graph-in-memory service only past roughly 10M users or when multi-hop
  ranking (3+ hops, ML features) is needed.

## 8. Encryption roadmap (E2E later)
v1 uses TLS in transit and encryption at rest. E2E is added later **without a rewrite** because v1 already:
- Treats the message body as an opaque payload (`payload` bytea + `enc_version`), no server logic depends
  on reading it (no server-side search of messages, no server link previews).
- Has a `devices` table and addresses messages to **devices**, not just users.
- Reserves tables for identity keys and prekeys.

What changes at E2E time: Signal protocol (X3DH + Double Ratchet, sender keys for groups) in the client,
key upload/fetch endpoints, per-device fan-out, encrypted media keys, client-side search and backups.
Old plaintext messages stay as-is (flagged `enc_version = 0`).

## 9. Security baseline
Argon2/bcrypt for any secrets, refresh-token rotation with reuse detection, per-IP and per-user rate limits
(Redis), DTO validation (class-validator), parameterised queries only, signed media URLs, audit log for
moderation actions.

## 10. Deployment
- Local: Docker Compose (Postgres, Redis, MinIO, LiveKit).
- MVP: single VPS or Railway/Fly.io; managed Postgres and Redis; R2/S3 + CDN.
- Scale path: horizontal API replicas behind LB (Socket.IO via Redis adapter), read replicas, extract
  `chat` and `media workers` first, then `live`.
- CI: GitHub Actions (lint, test, build, EAS build for mobile).
