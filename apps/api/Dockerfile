# Build context is the repository root:  docker build -f apps/api/Dockerfile -t social-api .

# ---- build: full toolchain, dev dependencies, TypeScript compile -------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @social/api...

COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @social/shared build && pnpm --filter @social/api build

# A self-contained copy of the API with production dependencies only (no TypeScript, Nest CLI, test tools).
RUN pnpm --filter @social/api deploy --prod /out

# Trim what the server never loads: ffprobe binaries for other operating systems, the two NSFW models we do not
# use (only MobileNetV2 is loaded), and source maps / TypeScript declarations / docs.
RUN cd /out/node_modules \
 && arch="$(node -p process.arch)" \
 && find ffprobe-static/bin -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
 && find ffprobe-static/bin/linux -mindepth 1 -maxdepth 1 ! -name "$arch" -exec rm -rf {} + \
 && rm -rf nsfwjs/dist/models/inception_v3 nsfwjs/dist/models/mobilenet_v2_mid \
 && find . -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.md' \) -delete

# ---- runtime: just Node, the compiled API and its production dependencies -----------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
EXPOSE 3000

# Apply migrations, then start. DATABASE_URL and the other settings come from the environment.
CMD ["sh", "-c", "node node_modules/node-pg-migrate/bin/node-pg-migrate.js up -m migrations --migration-file-language sql && node dist/main.js"]
