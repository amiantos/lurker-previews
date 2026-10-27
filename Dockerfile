# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0

# debian-slim (glibc) rather than alpine (musl) so sharp installs from its
# published linux-x64 / linux-arm64 prebuilds instead of compiling from source
# — same reasoning as the lurker cell image, whose Dockerfile carries the long
# version. Track the LTS line (24, EOL 2028-04-30); odd majors never become LTS.
#
# ⚠ Pinned by DIGEST, not tag: a tag is mutable, and an image built from "whatever
# node:24-slim is today" cannot be reproduced or audited. Dependabot (docker
# ecosystem, .github/dependabot.yml) moves the digest; a human merges it.
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Test stage: the full suite in the image's own environment — which is the ONLY
# environment with ffmpeg guaranteed, so the poster tests that skip on a bare
# dev machine run for real here. `docker build --target test .` is the gate.
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS test

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg procps \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci
# ⚠ A known-vulnerable RUNTIME dependency fails a LOCAL `docker build --target test`
# here. This is how sharp 0.35.3 sat two security releases behind for two months:
# nothing looked. ⚠ Not the CI gate: this layer is cached on an unchanged lockfile and
# would not re-query the advisory database — the workflow runs the same audit on the
# runner, uncached, before building. Dev-only advisories are not gated (they never
# reach the runtime image) but Dependabot opens a PR for them all the same.
RUN npm audit --omit=dev --audit-level=high
COPY tsconfig.json vitest.config.ts ./
COPY server/ ./server/
RUN npx vitest run

# Runtime image.
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

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

# libuv's pool is four threads by default and is shared by every sharp decode and
# every DNS lookup; two avatar decodes in flight (avatar.ts's pool) would leave the
# resolve path's lookups queued behind them. Eight keeps them apart and is still
# nothing against --pids-limit.
ENV UV_THREADPOOL_SIZE=8

EXPOSE 8030

# Runs directly from TypeScript via tsx (no build step), like the cell image.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "server/index.ts"]
