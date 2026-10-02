# syntax=docker/dockerfile:1
# Bambuzle — multi-stage image for linux/amd64 and linux/arm64 (Raspberry Pi 4/5).
# Build:  docker build -t bambuzle .
# Multi-arch: docker buildx build --platform linux/amd64,linux/arm64 -t bambuzle .

# ---- build stage: install production deps (compiles better-sqlite3 if no prebuilt matches) ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime stage: slim image, no toolchain ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    BAMBUZLE_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json openapi.yaml ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

# TODO(BAM-34): switch to /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/spec').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
