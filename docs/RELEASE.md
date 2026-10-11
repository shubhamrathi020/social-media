# Release checklist (beta)

What exists, what you must do outside this repository, and what is still open. Items marked **you** need accounts,
credentials, money or decisions that only the owner can provide.

## 1. Run the whole thing locally

```bash
pnpm install && cp .env.example .env
pnpm infra:up                                   # Postgres, Redis, S3Mock, LiveKit
pnpm --filter @social/shared build
pnpm --filter @social/api migrate:up
OTP_DEV_CODE=123456 pnpm --filter @social/api start
cd apps/api && node scripts/smoke-friends.mjs   # then media, chat, groups, posts, stories, live, notifications, account
```

The same suites run in CI (`.github/workflows/ci.yml`) against real services, plus the moderation suite, unit tests,
an Android/iOS bundle of the app and a Docker image build.

To click through the app without a phone, run it in a browser against the local API
(`pnpm --filter @social/mobile exec expo start --web`). Native-only features (camera, contacts, push, live video,
secure storage) need a phone build.

## 2. Backend deployment

- **Image:** `docker build -f apps/api/Dockerfile -t social-api .` (multi-stage, about 780 MB, applies migrations on start).
- **Required environment** (the API refuses to boot in production with placeholders or missing values):
  `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET` (32+ chars), `CONTACT_PEPPER` (32+ random chars),
  `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `LIVEKIT_URL`, `LIVEKIT_HTTP_URL`, `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET`, `SMS_PROVIDER` (+ its settings), `PUSH_MODE=expo`, `TRUST_PROXY=1` behind a load balancer.
  Optional: `METRICS_TOKEN` (enables `/v1/metrics`), `SENTRY_DSN`, `ACCOUNT_PURGE_DAYS` (default 30),
  `AUTO_HIDE_REPORTS` (default 3), `CONTENT_SCAN=off` to disable image scanning. Never set `OTP_DEV_CODE`.
- **S3 / CDN:** point `S3_ENDPOINT` at S3 or R2, set `S3_PUBLIC_ENDPOINT` if clients reach storage through another host,
  and put a CDN in front for delivery.
- **LiveKit:** LiveKit Cloud or a hosted server with a public IP and open UDP/TCP RTC ports; set `webhook.urls` to
  `https://<api>/v1/live/webhook`.
- **Postgres / Redis:** managed services with backups. Redis holds presence, rate limits and job queues.
- **SMS** (**you**, costs money): set `SMS_PROVIDER` to `twilio`, `smsgate` (open-source gateway on your own Android
  phone + SIM) or `http` (any provider's JSON API, e.g. MSG91/Fast2SMS). In India, OTP SMS needs DLT registration of
  your business, sender ID and message template; set `SMS_TEMPLATE` to the approved text.
- **Moderators:** `node scripts/make-admin.mjs +91XXXXXXXXXX` grants moderator rights; the console is at `/v1/admin`.

## 3. Mobile builds

- **you:** an Expo account (free), `eas init` (adds the project id), Apple Developer Program (US$99/year, needed for
  TestFlight) and a Google Play Console account (US$25 once; new personal accounts must run a closed test with 12+
  testers for 14 days before going to production).
- **you:** replace the placeholder identifiers `com.example.social` in `apps/mobile/app.json` and the app name/icons.
- Live streaming needs a **development or production build**, not Expo Go: `eas build --profile development`.
- Set `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_SOCKET_URL` per profile in `eas.json` to the deployed API.
- Distribute with TestFlight (iOS) and Play internal/closed testing (Android): `eas build --profile preview`, then `eas submit`.

## 4. Store review requirements already covered

| Requirement | Status |
|---|---|
| In-app account deletion | Yes: immediate anonymisation, full erasure (rows and files) after 30 days |
| Data export | Yes: Settings, Download my data (JSON) |
| Report and block users/content | Yes: reports for users, posts, comments, stories; block everywhere |
| Moderation of user-generated content | Yes: moderator console, auto-hide after 3 reports, suspensions, audit log, open-source image scanning |
| Camera / microphone / photo / contacts purpose strings | Yes, in `app.json` |
| Privacy controls | Yes: who can message, last seen, stories; private account; forget uploaded contacts |
| Notification opt-outs | Yes, per type and per conversation (mute) |

## 5. Still open before a public launch

Free, but not done:
- **Messages are not end-to-end encrypted.** The schema is prepared (`payload`, `enc_version`, `devices`); the Signal
  protocol work is a separate phase. Say so honestly in the store listing; do not claim E2E.
- **Video scanning** looks at the poster frame only; the NSFW model is a first filter, not a guarantee.
- **Translations** cover tabs, sign-in and settings in Hindi; other screens are English.
- **Nothing has run on a physical phone yet.** The app bundles for Android/iOS in CI and its main flows were exercised
  in a browser against the real API (sign-in, feed, likes, comments, chats, groups, friends, alerts, settings, dark
  mode, Hindi). Camera, contacts, push, video playback and live video still need a device.

Needs you (accounts, money or legal text):
- SMS provider and DLT registration, Expo/Apple/Google accounts (sections 2 and 3).
- **Privacy policy and terms.** Write and host them (any static page works, e.g. GitHub Pages); both stores require
  a URL. Describe: phone number, contacts (sent once, stored only as keyed hashes, opt-in), uploaded media, push tokens,
  message content stored unencrypted at rest on the server, moderation and image scanning, 30-day erasure.

## 6. Suggested beta plan

1. Deploy API + managed Postgres/Redis + S3/R2 + LiveKit Cloud to a staging environment; run the smoke suites against it.
2. Wire a real SMS provider and test sign-in on a phone.
3. Ship a preview build to 12 to 20 testers through TestFlight / Play closed testing.
4. Watch the moderator console, error logs and `/v1/metrics`; fix what breaks; then widen the group.
