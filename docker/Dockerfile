FROM node:26-slim AS base
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ── Stage 1: Install dependencies ──────────────────────────────────────────────
FROM base AS deps

# better-sqlite3 (Prisma 7's SQLite driver adapter) compiles native bindings on
# install; node:26-slim has no prebuilt binary for this ABI yet, so a C/C++
# toolchain is required. These build tools stay in the deps stage and never
# reach the runner image.
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install

# ── Stage 2: Build the application ────────────────────────────────────────────
FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p public && npx prisma generate && npx next build

# Bundle the background worker for production (native modules stay external)
RUN npx esbuild src/worker.ts --bundle --platform=node --target=node20 \
      --outfile=dist/worker.js \
      --external:@russellthehippo/honker-node \
      --external:@prisma/client \
      --external:@prisma/adapter-better-sqlite3 \
      --external:better-sqlite3

# ── Stage 3: Production runner ────────────────────────────────────────────────
FROM node:26-slim AS runner
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

ARG APP_VERSION=0.0.0
ARG APP_RELEASE_DATE=1970-01-01

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV APP_VERSION=${APP_VERSION}
ENV APP_RELEASE_DATE=${APP_RELEASE_DATE}

LABEL org.opencontainers.image.version=${APP_VERSION}
LABEL org.opencontainers.image.created=${APP_RELEASE_DATE}

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/version.json ./version.json
COPY --from=builder /app/CHANGELOG.md ./CHANGELOG.md
COPY --from=builder /app/dist/worker.js ./worker.js
COPY --from=builder /app/node_modules/@russellthehippo ./node_modules/@russellthehippo
# better-sqlite3 ships a native binary that can't be bundled; the worker keeps it
# external and the web server's traced copy also resolves it from here.
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

COPY docker/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh && \
    chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
