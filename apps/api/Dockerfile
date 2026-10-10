# Build context is the repository root:  docker build -f apps/api/Dockerfile -t social-api .
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /app

# Install dependencies first so source changes do not invalidate this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @social/api... --prod=false

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @social/shared build && pnpm --filter @social/api build

# Drop dev dependencies from the final image.
RUN pnpm prune --prod

USER node
WORKDIR /app/apps/api
EXPOSE 3000

# Apply migrations, then start. DATABASE_URL and the other settings come from the environment.
CMD ["sh", "-c", "node ../../node_modules/node-pg-migrate/bin/node-pg-migrate.js up -m migrations --migration-file-language sql && node dist/main.js"]
