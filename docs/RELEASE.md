# Release checklist (beta)

What exists, what you must do outside this repository, and what is still open. Items marked **you** need accounts,
credentials or decisions that only the owner can provide.

## 1. Run the whole thing locally

```bash
pnpm install && cp .env.example .env
pnpm infra:up                                   # Postgres, Redis, S3Mock, LiveKit
pnpm --filter @social/shared build
pnpm --filter @social/api migrate:up
OTP_DEV_CODE=123456 pnpm --filter @social/api start
cd apps/api && node scripts/smoke-friends.mjs   # then media, chat, posts, stories, live, notifications
```

The same suites run in CI (`.github/workflows/ci.yml`) against real services.

## 2. Backend deployment

- **Image:** `docker build -f apps/api/Dockerfile -t social-api .` (built and run during Phase 9; applies migrations on
  start). It is about 2 GB because dev dependencies are not stripped; a multi-stage `pnpm deploy` build would shrink it.
- **Required environment** (the API refuses to boot in production with placeholders):
  `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET` (32+ chars), `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
  `S3_BUCKET`, `LIVEKIT_URL`, `LIVEKIT_HTTP_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `PUSH_MODE=expo`,
  `TRUST_PROXY=1` behind a load balancer. Do **not** set `OTP_DEV_CODE`.
- **S3 / CDN:** point `S3_ENDPOINT` at S3 or R2, set `S3_PUBLIC_ENDPOINT` if clients reach storage through another host,
  and put a CDN in front for delivery.
- **LiveKit:** use LiveKit Cloud or a hosted server with a public IP and open UDP/TCP RTC ports; set `webhook.urls`
  to `https://<api>/v1/live/webhook`.
- **Postgres / Redis:** managed services with backups. Redis holds presence, rate limits and job queues, so enable
  persistence or accept that those reset on restart.
- **SMS:** the OTP sender is a console logger. **you:** provide Twilio/Firebase credentials and implement `OtpSender`
  (one class, see `modules/auth/otp-sender.ts`). Without this nobody can sign in outside development.

## 3. Mobile builds

- **you:** an Expo account, `eas init` (adds the project id), Apple Developer and Google Play accounts.
- **you:** replace the placeholder identifiers `com.example.social` in `apps/mobile/app.json` and the app name/icons.
- Live streaming needs a **development or production build**, not Expo Go: `eas build --profile development`.
- Set `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_SOCKET_URL` per profile in `eas.json` to the deployed API.
- Distribute with TestFlight (iOS) and Play internal testing (Android): `eas build --profile preview`, then `eas submit`.
- Push notifications on iOS need APNs credentials, which EAS can generate for you.

## 4. Store review requirements already covered

| Requirement | Status |
|---|---|
| In-app account deletion | Yes: Settings, Delete account (soft delete now, purge job for content) |
| Report and block users/content | Yes: reports for users, posts, comments, stories; block everywhere |
| Camera / microphone / photo purpose strings | Yes, in `app.json` |
| Privacy controls | Yes: who can message, last seen, stories; private account |
| Notification opt-outs | Yes, per type |

## 5. Still open before a public launch

- **Moderation tooling.** Reports are stored but there is no reviewer UI, no automatic takedown, and no image/video
  content scanning. Required for app-store policy on user-generated content at scale.
- **Privacy policy and terms.** **you:** write and host them; both stores require a URL. Describe: phone number,
  contacts hashes (opt-in), uploaded media, push tokens, message content stored unencrypted at rest on the server.
- **Messages are not end-to-end encrypted.** The schema is prepared (`payload`, `enc_version`, `devices`); the Signal
  protocol work is a separate phase. Say so honestly in the store listing; do not claim E2E.
- **Account data export / full purge.** Deletion removes the profile and revokes sessions; the complete erasure of
  messages and uploaded media on deletion is not automated yet (required by GDPR/DPDP-style rules).
- **Contact discovery privacy.** Phone hashes are unsalted SHA-256 of a small number space and can be brute-forced.
  Acceptable for a beta, weak for a large launch; use a server-side private-set-intersection scheme or at least a
  per-deployment pepper.
- **Group management.** Groups can be created and used; adding/removing members, admins and leaving are not built.
- **Mobile polish.** The screens are functional, not designed: no real theming, accessibility labels, localisation,
  image caching library, or empty/error state illustrations. Nothing in this repo has been run on a physical phone.
- **Observability.** Logs are plain Nest logs. Add error tracking (Sentry), metrics and alerting before real users.
- **Load.** See `PERFORMANCE.md` for what was and was not measured.

## 6. Suggested beta plan

1. Deploy API + managed Postgres/Redis + S3/R2 + LiveKit Cloud to a staging environment; run the smoke suites against it.
2. Wire a real SMS provider and test sign-in on a phone.
3. Ship a preview build to 10 to 20 testers through TestFlight / Play internal testing.
4. Watch error logs and the `reports` table; fix what breaks; then widen the group.
