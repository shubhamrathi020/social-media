# Product Requirements (PRD)

Working name: **Social** (placeholder). A mobile social app combining messaging (WhatsApp/Telegram), stories and posts (Instagram), and live streaming.

## 1. Goals
- Ship an MVP on iOS and Android from one codebase.
- Real-time feel: messages, likes and comment counts update instantly.
- Architecture that survives growth: modular monolith now, extractable modules later.

## 2. Non-goals (v1)
- End-to-end encryption (planned, see ARCHITECTURE.md §8; data model is already prepared).
- Monetisation, ads, creator payouts.
- Web client, desktop client.
- Audio/video calls (live streaming only).

## 3. Users and core concepts
| Concept | Definition |
|---|---|
| User | Account identified by phone number (OTP login), with username, display name, avatar, bio. |
| Friend | **Mutual** relationship: request, then accept. Required for private messaging by default. |
| Close friend | **One-directional** list a user curates from their friends. Used to restrict audience of stories/posts. |
| Suggestion | Recommended people to add, from mutual friends and phone contacts. |
| Post | 1 to **5 slides** (image or video each), caption, appears on feed and profile. |
| Story | Image/video, disappears after 24h. Audience: all friends or close friends only. |
| Status | Short text/emoji/mood or media status shown in chat list (WhatsApp-style), 24h. |
| Live | Real-time video broadcast with live chat, likes and viewer count. |

## 4. Feature requirements

### 4.1 Auth and profile
- Phone OTP signup/login, JWT access + refresh tokens, multi-device sessions.
- Edit profile: username (unique), name, bio, avatar.
- Account privacy: public / friends-only profile.

### 4.2 Friends
- Search users by username/name/phone.
- Send, cancel, accept, decline friend request. Unfriend. Block / unblock.
- Close friends: add/remove from friends list.
- Suggestions: mutual friends ranking, phone contacts match (opt-in), dismiss a suggestion.

### 4.3 Messaging
- 1:1 chat and group chat (v1.1).
- Text, image, video, voice note, file; reply, delete for me / for everyone.
- Delivery states: sent, delivered, read. Typing indicator. Online/last-seen (privacy controlled).
- Offline queue and sync; push notifications for new messages.

### 4.4 Posts
- Create post with 1 to 5 slides, each image or video. Hard limit enforced in API and DB.
- Feed (friends + followed content, reverse-chronological in v1), profile grid.
- Like or dislike (one reaction per user; dislike totals visible to the author only), comment, reply to comment, react to comments, delete own, report.
- Instant counters via real-time events.

### 4.5 Stories and statuses
- Create story (image/video, text overlay), 24h expiry, viewer list, reactions/replies (go to DM).
- Audience selector: friends or close friends.
- Story ring on avatars; seen/unseen state.
- Statuses: text/media, 24h, visible to friends.

### 4.6 Live streaming
- Go live, viewers join, live chat, hearts, viewer count, end stream.
- Notify friends when going live. Stream replay is out of scope for v1.

### 4.7 Notifications
- Push + in-app: friend request/accept, message, like, comment, live started, story reply.
- Per-type toggles in settings.

### 4.8 Settings
- Account (phone, username, delete account), privacy (who can message, see last seen, see stories),
  notifications, blocked users, close friends manager, media (data saver, autoplay), language, theme (light/dark), logout / manage sessions.

## 5. Non-functional requirements
| Area | Target |
|---|---|
| Latency | Chat delivery < 300 ms p95 same region; like count propagation < 500 ms |
| Availability | 99.5% MVP |
| Media | Upload via presigned URL, video transcoded to HLS, thumbnails generated |
| Security | TLS everywhere, hashed refresh tokens, rate limiting, input validation, signed media URLs for private content |
| Privacy | Account deletion purges data within 30 days; block is enforced on all surfaces |
| Observability | Structured logs, metrics, error tracking from day one |

## 6. Success metrics (MVP)
- D1 / D7 retention, messages sent per DAU, posts per DAU, story views per DAU, friend requests accepted ratio.

## 7. Open questions
- Group chat size limit and admin roles.
- Content moderation approach (report queue vs automated).
- Contacts-sync consent copy and regional compliance (GDPR, DPDP).
