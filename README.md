# Social

Mobile social app: real-time chat, posts (up to 5 slides), stories, statuses, live streaming.
Design docs live in [docs/](docs). Stack: Expo (React Native) + NestJS modular monolith + PostgreSQL + Redis + S3/MinIO + LiveKit.

## Layout
```
apps/api        NestJS API (REST under /v1, Socket.IO gateway)
apps/mobile     Expo app (expo-router)
packages/shared Types/constants shared by API and mobile
infra/          docker-compose (Postgres :5433, Redis :6380, S3Mock :9090)
docs/           PRD, architecture, data model, API, roadmap
```

## Run it
```bash
pnpm install
cp .env.example .env
pnpm infra:up                                   # needs Docker running
pnpm --filter @social/shared build
pnpm --filter @social/api migrate:up
pnpm --filter @social/api dev                   # http://localhost:3000/v1/health
pnpm --filter @social/mobile dev                # scan the QR with Expo Go
```

## Checks
```bash
pnpm typecheck && pnpm test
```
