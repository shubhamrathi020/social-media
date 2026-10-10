# Roadmap

**Status:** phases 0 to 9 are implemented and verified by the end-to-end suites in `apps/api/scripts/`. What is left
before a public launch is listed in [RELEASE.md](RELEASE.md) (section 5).

Each phase ends with something demoable on a real phone. Estimates assume one developer working with Claude; scale accordingly.

| Phase | Scope | Rough size |
|---|---|---|
| 0. Foundations | Monorepo (Turborepo), NestJS skeleton, Expo app skeleton, Docker Compose (Postgres, Redis, MinIO), migrations, CI, lint/format, env config, logging | 1 week |
| 1. Identity | Phone OTP, JWT + refresh, profile, settings storage, app navigation shell, theming | 1-2 weeks |
| 2. Friends | Search, requests, friends list, close friends, blocks, suggestions v1 (mutual friends), contact sync | 1-2 weeks |
| 3. Media | Presigned uploads, processing worker (thumbs, HLS), media picker, upload progress | 1-2 weeks |
| 4. Chat | Socket gateway, 1:1 chat, receipts, typing, presence, push, offline sync, media messages | 3 weeks |
| 5. Posts | Create (up to 5 slides), feed, profile grid, likes, comments, live counters | 2-3 weeks |
| 6. Stories and statuses | Create, ring UI, viewer, 24h expiry job, audience (friends / close friends), replies to DM | 2 weeks |
| 7. Live streaming | LiveKit integration, go live, watch, live chat, hearts, viewer count, notify friends | 2 weeks |
| 8. Polish and settings | Full settings screens, notification prefs, moderation/report, rate limits, analytics, perf pass | 2 weeks |
| 9. Beta | TestFlight / Play internal testing, load test, bug fixing, store listings | 2 weeks |

## After v1 (backlog)
- Group chats enhancements (admins, invite links), channels (Telegram-style).
- **E2E encryption** (Signal protocol) - schema already prepared, see ARCHITECTURE.md §8.
- Feed ranking, fan-out-on-write, search service (Meilisearch).
- Reels-style short video, stream replays, calls.
- Extract `chat`, then `media workers`, then `live` into services if load demands.

## Definition of done (per feature)
API spec updated, migration reviewed, unit + e2e tests for rules (blocks, audiences, limits), loading/empty/error states in app,
works offline-tolerant where relevant, no secrets in repo.
