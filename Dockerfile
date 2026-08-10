# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0

# debian-slim (glibc) rather than alpine (musl) so sharp installs from its
# published linux-x64 / linux-arm64 prebuilds instead of compiling from source
# — same reasoning as the lurker cell image, whose Dockerfile carries the long
# version. Track the LTS line (24, EOL 2028-04-30); odd majors never become LTS.
FROM node:24-slim AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Test stage: the full suite in the image's own environment — which is the ONLY
# environment with ffmpeg guaranteed, so the poster tests that skip on a bare
# dev machine run for real here. `docker build --target test .` is the gate.
FROM node:24-slim AS test

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY server/ ./server/
RUN npx vitest run

# Runtime image.
FROM node:24-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json tsconfig.json ./
COPY server/ ./server/

# ⚠ Non-root is part of the posture, not a nicety: this process exists to run
# memory-unsafe parsers on bytes strangers chose. The runtime flags in the
# README (--read-only, --tmpfs /tmp, --cap-drop ALL, --memory, --pids-limit and
# the egress rules) are the other half; a Dockerfile cannot express them.
USER node

EXPOSE 8030

# Runs directly from TypeScript via tsx (no build step), like the cell image.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "server/index.ts"]
