// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Avatars (lurker#1190): one image fetched from its origin, decoded, cropped square and
// resized, and answered as WebP bytes the cell caches. The avatar another user set is an
// involuntary fetch for everyone who sees them talk, so the origin's full-size bytes are
// never what reaches a browser, and a decode that would cost a viewer's browser too much is
// paid here, bounded, instead.
//
// ⚠⚠ This endpoint never answers 404. The cell reads a 404 from `/avatar` as "this decoder
// predates the endpoint" and falls back to the plain `/fetch` relay, which is what makes a
// cell updated before its decoder a non-event. A dead origin is a 502, a refusal a 403.
//
// The fetch guards are `/fetch`'s (see fetchImage.ts for the bug behind each): the host
// cooldown before anything is spent, one retry on a transient status, images only, the byte
// cap on bytes actually seen. What differs is that the body is BUFFERED — sharp needs all of
// it — so the cap is enforced by reading at most one byte past it.

import type { ServerResponse } from 'node:http';
import sharp, { type Metadata } from 'sharp';
import { bufferStream, normalizeUrl, safeRequest, UnsafeUrlError } from './services/linkFetch.js';
import { cooldownRemaining, isTransientStatus, noteRefusal } from './utils/originCooldown.js';
import { MAX_IMAGE_PROXY_BYTES, proxyableContentType } from './fetchImage.js';
import { SlotPool } from './utils/slotPool.js';
import { withDeadline, DeadlineExceeded } from './utils/withDeadline.js';

/** The longest side of an avatar. The profile modal draws one at 4em, ~190 device px on a
 *  3x phone; 256 keeps it sharp there, and it's the size of the uploaded tile sets. */
export const AVATAR_SIZE = 256;

/** A still that decodes to more than this is refused: an 8 MB file can describe a
 *  gigapixel canvas, and that decode is the cost this endpoint exists to bound. */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * An animation is decoded whole only when ALL its frames together fit this; past it, only its
 * first frame is (Brad, lurker#1190). A 500×500 GIF of 80 frames is 20 MP — a long, large
 * one is a decompression bomb with a frame count.
 */
const MAX_ANIMATED_PIXELS = 20_000_000;

/** A resized animation larger than this is sent as its first frame instead. Generous for a
 *  256 px loop; a still avatar is tens of KB. */
const MAX_ANIMATED_BYTES = 512 * 1024;

const QUALITY = 80;

/**
 * Avatars in flight. Small: each one is a fetch AND a decode, and a decode runs on libuv's
 * pool, which the resolver's DNS lookups share. The cell's own pool and per-user throttle
 * bound what reaches it; this bounds what one cell — or the next caller — can make it do.
 */
const avatarPool = new SlotPool({ size: 8, maxQueued: 100, waitMs: 5_000 });

/** One avatar, start to finish: the origin's hop deadline plus a decode. */
const AVATAR_DEADLINE_MS = 30_000;

const ORIGIN_ATTEMPTS = 2;

export interface Avatar {
  webp: Buffer;
  animated: boolean;
}

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(`avatar refused (${status})`);
  }
}

export interface AvatarLimits {
  maxInputPixels: number;
  maxAnimatedPixels: number;
  maxAnimatedBytes: number;
}

const LIMITS: AvatarLimits = {
  maxInputPixels: MAX_INPUT_PIXELS,
  maxAnimatedPixels: MAX_ANIMATED_PIXELS,
  maxAnimatedBytes: MAX_ANIMATED_BYTES,
};

/**
 * The image made an avatar: square, at most AVATAR_SIZE a side, never enlarged, WebP.
 * Exported for its tests, which pass small `limits` rather than build 50 MP images.
 */
export async function makeAvatar(input: Buffer, limits: AvatarLimits = LIMITS): Promise<Avatar> {
  const { maxInputPixels, maxAnimatedPixels, maxAnimatedBytes } = limits;
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: maxInputPixels }).metadata();
  } catch {
    throw new Refused(415);
  }
  // SVG is refused upstream by content type; checked again here on the bytes.
  if (!meta.format || meta.format === 'svg' || !meta.width || !meta.height) {
    throw new Refused(415);
  }
  const width = meta.width;
  const height = meta.pageHeight || meta.height;
  const pages = meta.pages || 1;
  const side = Math.max(1, Math.min(AVATAR_SIZE, width, height));

  // Checked here to skip a decode that would only fail: limitInputPixels below bounds it too.
  if (pages > 1 && width * height * pages <= maxAnimatedPixels) {
    try {
      const out = await sharp(input, { animated: true, limitInputPixels: maxAnimatedPixels })
        .resize(side, side, { fit: 'cover', position: 'centre' })
        .webp({ quality: QUALITY })
        .toBuffer();
      if (out.length <= maxAnimatedBytes) return { webp: out, animated: true };
    } catch {
      // Its first frame, below, like an animation over the budget.
    }
  }

  try {
    const out = await sharp(input, { limitInputPixels: maxInputPixels, page: 0 })
      .rotate()
      .resize(side, side, { fit: 'cover', position: 'attention' })
      .webp({ quality: QUALITY })
      .toBuffer();
    return { webp: out, animated: false };
  } catch {
    throw new Refused(415);
  }
}

/** The origin's bytes for `url`, or a Refused carrying the status to answer. */
async function fetchBytes(url: URL, signal: AbortSignal): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    const upstream = await safeRequest(url, { accept: 'image/*,*/*;q=0.5', signal });
    if (attempt < ORIGIN_ATTEMPTS && isTransientStatus(upstream.status)) {
      upstream.stream.destroy();
      continue;
    }
    if (upstream.status !== 200) {
      upstream.stream.destroy();
      if (!isTransientStatus(upstream.status)) throw new Refused(502);
      noteRefusal(url.hostname, upstream.headers);
      throw new Refused(503, cooldownRemaining(url.hostname) || 60);
    }
    if (!proxyableContentType(upstream.contentType)) {
      upstream.stream.destroy();
      throw new Refused(415);
    }
    const declared = Number(upstream.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_IMAGE_PROXY_BYTES) {
      upstream.stream.destroy();
      throw new Refused(413);
    }
    // One byte past the cap: a body that reaches it is over.
    const read = await bufferStream(upstream, { maxBytes: MAX_IMAGE_PROXY_BYTES + 1 });
    if (read.body.length > MAX_IMAGE_PROXY_BYTES) throw new Refused(413);
    // Cut short some other way (the peer went, a deadline): nothing whole to decode.
    if (read.truncated) throw new Refused(502);
    return read.body;
  }
}

/** `POST /avatar`: answer `url`'s image as an avatar. Owns its status codes end to end. */
export async function handleAvatar(res: ServerResponse, rawUrl: string): Promise<void> {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('refused');
    return;
  }
  const cooling = cooldownRemaining(url.hostname);
  if (cooling > 0) {
    res.writeHead(503, { 'retry-after': String(cooling) }).end();
    return;
  }
  if (!(await avatarPool.acquire())) {
    res.writeHead(503, { 'retry-after': '5' }).end();
    return;
  }
  const controller = new AbortController();
  const work = fetchBytes(url, controller.signal).then(makeAvatar);
  try {
    const avatar = await withDeadline(work, AVATAR_DEADLINE_MS, 'avatar');
    res.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': String(avatar.webp.length),
      ...(avatar.animated ? { 'x-lurker-avatar-animated': '1' } : {}),
    });
    res.end(avatar.webp);
  } catch (err) {
    controller.abort();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof Refused) {
      res
        .writeHead(err.status, err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {})
        .end();
      return;
    }
    // Out of time is a fact about a moment, as for /resolve: transient.
    if (err instanceof DeadlineExceeded) {
      res.writeHead(503, { 'retry-after': '30' }).end();
      return;
    }
    if (err instanceof UnsafeUrlError) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('refused');
      return;
    }
    res.writeHead(502).end();
  } finally {
    // ⚠ The slot goes back when the WORK ends, not when the answer does. The abort ends a
    // fetch, but a decode can't be stopped, and a slot freed while one still runs is the
    // undercount the pool exists to prevent (see server.ts on RESOLVE_DEADLINE_MS).
    void work.then(
      () => avatarPool.release(),
      () => avatarPool.release(),
    );
  }
}
