# syntax=docker/dockerfile:1
# Canvass API — multi-stage build, runs as a non-root user.

# ---- build: compile TypeScript --------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- deps: production node_modules only -----------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime --------------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3000
# What is running, for the footer: set by the Makefile (`make restart-tunnel`, `make up`) from git.
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=
ENV GIT_COMMIT=$GIT_COMMIT BUILD_TIME=$BUILD_TIME
WORKDIR /app
RUN apk add --no-cache curl && addgroup -S canvass && adduser -S -G canvass -H canvass
COPY --from=deps  --chown=canvass:canvass /app/node_modules ./node_modules
COPY --from=build --chown=canvass:canvass /app/dist ./dist
COPY --chown=canvass:canvass package.json ./
# SIGN_PHOTO_DIR's mount point has to exist in the image, owned by the user the API runs as.
# Docker seeds a fresh named volume from the image path it is mounted over — including its
# ownership — but only if that path exists; mounting over a path the image does not have creates
# the volume root-owned, and an API running as `canvass` then cannot write a single sign photo
# (EACCES on every upload, with the placement itself saving fine because that is a database write).
# This does NOT repair a volume that already exists: see README "Sign photos fail with EACCES".
RUN mkdir -p /photos && chown canvass:canvass /photos
USER canvass
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.js"]
