// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Unit tests for the seams `resolve.ts` exports on purpose. Moved from lurker's
// linkPreview.test.ts along with the code; what stayed behind is everything that
// asserts identity, TTLs or descriptors, which are the cell's business.

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { pageMeta, dimensionsFromHead } from './resolve.js';

describe('pageMeta: what is enough to be worth a card', () => {
  it('keeps a video embed that has neither a title nor an image', () => {
    // ⚠⚠ Regression guard. `!title && !imageUrl` are PAGE concepts, and the give-up rule
    // consulted only those: a YouTube link whose provider oEmbed call failed — rate-limited,
    // endpoint retired, "none of which should mean no preview at all" — falls through to a
    // scrape that finds nothing, because YouTube's og: tags sit past the 512 KB cap. So the
    // embed URL it was already holding was thrown away.
    //
    // Tested here rather than through the live-origin harness because `videoEmbedFor` only
    // matches real provider hosts, so this branch is unreachable from a loopback server — and a
    // test that stops at the HTTP surface never runs this rule at all. (It didn't, in the cell.
    // It passed with the fix reverted, which is what put this test here.)
    const out = pageMeta(new URL('https://www.youtube.com/watch?v=abc123'), null, {});
    expect(out).not.toBeNull();
    expect(out!.kind).toBe('video-embed');
    expect(out!.embedUrl).toContain('youtube-nocookie.com');
    // ⚠ The null title is load-bearing for the CELL: `title || imageUrl` is how it tells a full
    // card from a degraded play-button-and-hostname one when it picks a TTL. The TTL test lives
    // with the cell; this pins the input it computes from.
    expect(out!.title).toBeNull();
  });

  it('still gives up on an ordinary page with nothing to show', () => {
    // The rule has to keep doing its job: a card with no title, no image and no embed is a grey
    // rectangle, and the plain link the user typed is better.
    expect(pageMeta(new URL('https://example.com/blank'), null, {})).toBeNull();
  });

  it('carries the SCRAPED image shape onto the metadata', () => {
    // ⚠⚠ The client picks between a hero band and a 72px chip from this pair. This is the
    // plumbing that changed in resolver v4, and nothing else tests it: `scrapeMeta`'s own suite
    // stops at the meta object.
    const out = pageMeta(new URL('https://news.example/article'), null, {
      title: 'A headline',
      imageUrl: 'https://news.example/card.png',
      imageWidth: 1200,
      imageHeight: 630,
    });
    expect(out!.imageWidth).toBe(1200);
    expect(out!.imageHeight).toBe(630);
  });

  it('prefers the oEmbed thumbnail SHAPE when the oEmbed thumbnail is the image taken', () => {
    // ⚠ The pairing rule: `thumbnail_width` describes `thumbnail_url`, so when that image wins
    // the ladder the scraped og:image's numbers must not ride along. A 4:3 hole for a 16:9
    // picture is the reflow these fields exist to prevent — and a hero band for what is really
    // a logo.
    const out = pageMeta(
      new URL('https://news.example/article'),
      {
        thumbnailUrl: 'https://news.example/oembed.png',
        thumbnailWidth: 256,
        thumbnailHeight: 256,
      },
      {
        title: 'A headline',
        imageUrl: 'https://news.example/card.png',
        imageWidth: 1200,
        imageHeight: 630,
      },
    );
    expect(out!.imageUrl).toBe('https://news.example/oembed.png');
    expect(out!.imageWidth).toBe(256);
    expect(out!.imageHeight).toBe(256);
  });

  it('leaves the shape null when the oEmbed thumbnail wins but declares no size', () => {
    // ⚠ The scraped numbers describe the og:image, which just LOST — so they are not a fallback,
    // they are a different picture's dimensions. Unknown is the correct answer here.
    const out = pageMeta(
      new URL('https://news.example/article'),
      { thumbnailUrl: 'https://news.example/oembed.png' },
      {
        title: 'A headline',
        imageUrl: 'https://news.example/card.png',
        imageWidth: 1200,
        imageHeight: 630,
      },
    );
    expect(out!.imageUrl).toBe('https://news.example/oembed.png');
    expect(out!.imageWidth).toBeNull();
    expect(out!.imageHeight).toBeNull();
  });
});

describe('dimensionsFromHead: the numbers a client reserves a box from', () => {
  // ⚠⚠ These are a LAYOUT PROMISE, not a statistic. The client reserves an image's box from this
  // ratio before any bytes arrive (MessageAttachment's `reserveStyle`, lurker#705), so a pair that
  // disagrees with what the browser decodes is a permanently wrong-shaped box rather than a jump.
  async function jpeg(w: number, h: number, orientation?: number) {
    const img = sharp({ create: { width: w, height: h, channels: 3, background: '#888' } });
    return await (orientation ? img.withMetadata({ orientation }) : img).jpeg().toBuffer();
  }

  it('reports what the BROWSER will decode, not what the file stores', async () => {
    // A phone photo shot in portrait: stored landscape, with orientation 6 telling the decoder to
    // rotate it. Browsers honour that (`image-orientation: from-image` is the default) and sharp's
    // `metadata()` does not — so reading `meta.width`/`meta.height` hands the client a transposed
    // box for the most ordinary photo on the platform.
    const rotated = await jpeg(400, 300, 6);

    // ⚠ The probe is checked BEFORE it is trusted: sharp silently drops the tag on some write
    // paths (`withExifMerge` did, in the console probe that first tried this), and a fixture with
    // orientation 1 makes the assertion below pass against the very bug it guards.
    expect((await sharp(rotated).metadata()).orientation).toBe(6);

    expect(await dimensionsFromHead(rotated)).toEqual({ width: 300, height: 400 });

    // And the ordinary case is untouched — no tag, no transpose.
    expect(await dimensionsFromHead(await jpeg(400, 300))).toEqual({ width: 400, height: 300 });
  });

  it('falls back to the header reader for a container sharp refuses', async () => {
    // The 64 KB truncation case (lurker#697): webp/gif/tiff declare a total length and their
    // loaders reject a short file before decoding it. A real photo is far past the cap, so this
    // is the ordinary path for a pasted WebP — not an edge case.
    const webp = await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#111' },
    })
      .webp()
      .toBuffer();
    const truncated = webp.subarray(0, 40);

    // ⚠ Probe first: if sharp ever starts reading this buffer, the fallback stops being exercised
    // and the assertion below would pass through the branch it is not written to cover.
    // ⚠ Asserts THAT it rejects, never with what wording — libvips' message is its own business
    // and varies by version and platform.
    await expect(sharp(truncated).metadata()).rejects.toBeInstanceOf(Error);

    expect(await dimensionsFromHead(truncated)).toEqual({ width: 120, height: 80 });
    expect(await dimensionsFromHead(Buffer.from('not an image at all'))).toBeNull();
  });
});
