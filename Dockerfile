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

FROM node:24-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json tsconfig.json ./
COPY server/ ./server/

# ⚠ Non-root is part of the posture, not a nicety: this process exists to run
# memory-unsafe parsers on bytes strangers chose. The runtime flags in the
# README (--read-only, --cap-drop ALL, --memory, --pids-limit and the egress
# rules) are the other half; a Dockerfile cannot express them.
USER node

EXPOSE 8030

# Runs directly from TypeScript via tsx (no build step), like the cell image.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "server/index.ts"]
