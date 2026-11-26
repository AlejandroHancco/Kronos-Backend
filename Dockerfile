# syntax=docker/dockerfile:1
# Multi-stage image. Targets: api, worker.
#   docker build --target api    -t sc-api .
#   docker build --target worker -t sc-worker .
# Layer order matters for deploys: production node_modules only change with the lockfile or
# the Prisma schema, so a normal code change ships just the small `dist` layer.

FROM node:24-bookworm-slim AS toolchain
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Production dependencies + generated Prisma client (node_modules/.prisma).
FROM toolchain AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npx prisma generate

FROM toolchain AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:24-bookworm-slim AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
USER node

FROM runtime-base AS api
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/apps/api/main"]

FROM runtime-base AS worker
ENV HEALTH_PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["node", "dist/apps/worker/main"]
