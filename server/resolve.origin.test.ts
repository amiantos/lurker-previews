// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The resolver against a real origin, over real sockets.
//
// Its own file for the same reason `linkFetch.redirects.test.ts` is: the real address policy
// blocks loopback, correctly, so no test can watch a resolve COMPLETE against a server it just
// started. The policy is swapped for a test one — allow 127.0.0.1, refuse everything else — and
// everything else runs for real.
//
// ⚠ What's mocked is the POLICY, never the mechanism. The fetch, the redirect loop, the pinned
// lookup, the head scan, the charset decode and the scrape are all shipping code. The policy
// itself is tested against the real implementation in ./utils/ipGuard.test.ts.
//
// Moved from lurker's linkPreview.origin.test.ts along with the resolver. The tests that STAYED
// there are the ones about identity and caching — fragment collapse, in-flight coalescing,
// echo-as-asked — which belong to the cell's half of the split.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';

vi.mock('./utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const { resolveUrl } = await import('./resolve.js');
const { resetCooldownsForTests } = await import('./utils/originCooldown.js');

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let handler: Handler;
let hits: string[] = [];
let server: http.Server;
/** Reached through `localhost`, so the pinned lookup's success path is the one under test. */
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url || '');
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  // The cooldown map is module state keyed by host, and every test here shares one host.
  // A backoff armed by one test must not answer the next test's resolve.
  resetCooldownsForTests();
});

function reset(h: Handler) {
  hits = [];
  handler = h;
}

/** Serve one HTML document, whatever is asked for. */
function serveHtml(html: string, contentType = 'text/html; charset=utf-8'): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': contentType });
    res.end(html);
  };
}

function resolve(url: string) {
  return resolveUrl(url, new AbortController().signal);
}

describe('resolving a page at a live origin', () => {
  it('scrapes a card in one request, without fetching the image', async () => {
    reset(
      serveHtml(`<html><head>
        <meta property="og:title" content="Tom &amp; Jerry">
        <meta property="og:description" content="A cat and a mouse.">
        <meta property="og:site_name" content="Example Cartoons">
        <meta property="og:image" content="/art/still.png">
      </head><body><p>ignored</p></body></html>`),
    );

    const out = await resolve(`${base}/article`);
    expect(out.verdict).toBe('ok');
    if (out.verdict !== 'ok') return;
    expect(out.meta.kind).toBe('page');
    // Decoded exactly once. A second pass is what turns `&amp;amp;` into `&`, and both
    // producers decode at their own boundary now.
    expect(out.meta.title).toBe('Tom & Jerry');
    expect(out.meta.description).toBe('A cat and a mouse.');
    expect(out.meta.siteName).toBe('Example Cartoons');
    // Relative og:image resolved against the page we landed on, returned as an ORIGIN URL —
    // proxying it under the cell's own routes is the cell's business, at descriptor-mint time.
    expect(out.meta.imageUrl).toBe(`${base}/art/still.png`);
    // The head is all we pay for: no second GET for the body, and the image is NOT fetched
    // during resolve — the cell asks /fetch for it, and only if a client renders the card.
    expect(hits).toEqual(['/article']);
  });

  it('decodes an image URL exactly once', async () => {
    // ⚠ Regression guard. `scrapeMeta` and `readOEmbed` each decode entities at their own
    // boundary, so the resolver decoding `imageUrl` again is one pass too many — and a second
    // pass is invisible until a document contains a LITERAL entity: `&amp;amp;` is the correct
    // markup for the text `&amp;`, and decoding twice turns it into `&`, which is a different
    // URL and a 404 where a thumbnail should be.
    reset(
      serveHtml(`<html><head>
        <meta property="og:title" content="Twice">
        <meta property="og:image" content="/art.png?tag=a&amp;amp;b&amp;v=1">
      </head></html>`),
    );

    const out = await resolve(`${base}/entities`);
    expect(out.verdict === 'ok' && out.meta.imageUrl).toBe(`${base}/art.png?tag=a&amp;b&v=1`);
  });

  it('honours a charset the origin declared and the document does not', async () => {
    // ⚠ Regression guard for the `decodeBody` handoff. The old call passed the Content-Type
    // header, but what reached it was already stripped to a bare `text/html` — so the charset
    // branch could never match and a windows-1251 page with no in-document `<meta charset>`
    // rendered as replacement characters. Only a live origin can prove this: it needs the
    // header and the body to disagree with UTF-8 together.
    const cyrillic = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in cp1251
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/HTML; charset="Windows-1251"' });
      res.end(
        Buffer.concat([
          Buffer.from('<html><head><meta property="og:title" content="'),
          cyrillic,
          Buffer.from('"></head><body><p>x</p></body></html>'),
        ]),
      );
    });

    const out = await resolve(`${base}/cyrillic`);
    expect(out.verdict === 'ok' && out.meta.title).toBe('Привет');
  });

  it('uses the hostname when a page offers only a twitter handle', async () => {
    // `twitter:site` is an @handle naming an account, not a site. Absent beats wrong: the card
    // gets the hostname, which is always accurate.
    reset(
      serveHtml(`<html><head>
        <meta name="twitter:site" content="@examplenews">
        <meta property="og:title" content="Headline">
      </head><body><p>x</p></body></html>`),
    );

    const out = await resolve(`${base}/handle-only`);
    expect(out.verdict === 'ok' && out.meta.siteName).toBe('localhost');
  });

  it('reads an image’s dimensions without pulling the whole file', async () => {
    const png = await sharp({
      create: { width: 240, height: 100, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    });

    const out = await resolve(`${base}/photo.png`);
    expect(out.verdict).toBe('ok');
    if (out.verdict !== 'ok') return;
    expect(out.meta.kind).toBe('image');
    expect(out.meta.mime).toBe('image/png');
    // The point of reading these at all: the client reserves the box before the bytes arrive,
    // so a bottom-anchored message list doesn't grow a second time when the image decodes.
    expect(out.meta.imageWidth).toBe(240);
    expect(out.meta.imageHeight).toBe(100);
  });

  it('still builds a card when the page advertises a broken oEmbed endpoint', async () => {
    // ⚠ Regression guard. The oEmbed href comes out of a stranger's markup, and `new URL('http://[')`
    // throws while BUILDING the argument to the guard that was supposed to judge it — so with
    // the resolve outside the try, a malformed href abandoned the whole resolution and the page
    // got no preview at all. oEmbed is the OPTIONAL path: failing it must fall back to the Open
    // Graph tags already in hand, not discard them.
    reset(
      serveHtml(`<html><head>
        <meta property="og:title" content="Survived">
        <link rel="alternate" type="application/json+oembed" href="http://[">
      </head></html>`),
    );

    const out = await resolve(`${base}/broken-oembed`);
    expect(out.verdict === 'ok' && out.meta.title).toBe('Survived');
  });

  it('clamps a long title without splitting a character', async () => {
    // ⚠ Regression guard. The clamp used `slice`, which counts UTF-16 code units, so a title
    // of emoji cut at 140 ended in a lone high surrogate — which does not survive the cell's
    // SQLite round trip, and a strict decoder (Swift's JSONDecoder) turns into U+FFFD.
    reset(
      serveHtml(
        `<html><head><meta property="og:title" content="${'👍'.repeat(200)}"></head></html>`,
      ),
    );

    const out = await resolve(`${base}/emoji`);
    expect(out.verdict).toBe('ok');
    if (out.verdict !== 'ok') return;
    const title = out.meta.title as string;
    expect(title.length).toBeLessThan(400);
    const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lonely.test(title)).toBe(false);
  });

  it('keeps the scraped image when an oEmbed thumbnail is unusable', async () => {
    // ⚠ Regression guard. `oembed?.thumbnailUrl || meta.imageUrl` picked first and vetted
    // second, so a thumbnail_url we refuse — here a private address the SSRF guard blocks —
    // took the slot and then evaporated, discarding a perfectly good og:image with it.
    reset((req, res) => {
      if (req.url === '/oembed.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            version: '1.0',
            type: 'rich',
            thumbnail_url: 'http://10.0.0.9/private.png',
            thumbnail_width: 480,
            thumbnail_height: 360,
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head>
        <meta property="og:title" content="Fallback Kept">
        <meta property="og:image" content="/real.png">
        <link rel="alternate" type="application/json+oembed" href="/oembed.json">
      </head></html>`);
    });

    const out = await resolve(`${base}/oembed-bad-thumb`);
    expect(out.verdict).toBe('ok');
    if (out.verdict !== 'ok') return;
    expect(out.meta.imageUrl).toBe(`${base}/real.png`);
    // ...and the oEmbed dimensions do NOT come along: they describe the thumbnail that lost,
    // so pairing them with this image reserves a 4:3 box for a picture of another shape.
    expect(out.meta.imageWidth).toBeNull();
    expect(out.meta.imageHeight).toBeNull();
  });
});

describe('verdicts', () => {
  it('answers `none` for a page with nothing worth showing', async () => {
    reset(serveHtml('<html><head><title></title></head><body>plain</body></html>'));
    expect((await resolve(`${base}/blank`)).verdict).toBe('none');
  });

  it('answers `dead` for a content type it has no rendering for', async () => {
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4');
    });
    expect((await resolve(`${base}/paper.pdf`)).verdict).toBe('dead');
  });

  it('answers `dead` for SVG, which is a script host wearing a picture’s clothes', async () => {
    reset((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    });
    expect((await resolve(`${base}/logo.svg`)).verdict).toBe('dead');
  });

  it('answers `refused` for a blocked address without dialling anything', async () => {
    reset(serveHtml('unreachable'));
    const out = await resolve('http://10.6.6.6/blocked');
    expect(out.verdict).toBe('refused');
    expect(hits).toEqual([]);
  });

  it('answers `refused` for an absurdly long URL before anything is fetched', async () => {
    reset(serveHtml('unreachable'));
    const out = await resolve(`${base}/?q=${'a'.repeat(4000)}`);
    expect(out.verdict).toBe('refused');
    expect(hits).toEqual([]);
  });

  it('turns a 429 into `backoff` and honours it before the next fetch', async () => {
    // ⚠⚠ The transient split, across the new process boundary. "Not now" must not be reported
    // as "not ever": the cell caches `dead` for its failure TTL, and a rate-limited minute
    // cached that way blanks the link for an hour. The origin's own Retry-After rides along.
    reset((_req, res) => {
      res.writeHead(429, { 'retry-after': '120' });
      res.end();
    });

    const first = await resolve(`${base}/limited`);
    expect(first.verdict).toBe('backoff');
    if (first.verdict !== 'backoff') return;
    expect(first.retryAfterS).toBeGreaterThan(0);
    expect(first.retryAfterS).toBeLessThanOrEqual(120);
    expect(hits).toEqual(['/limited']);

    // The host said stop, so a second ask — for ANY url on that host — never leaves the
    // process. This is the gate the cell's resolve path never had: the cooldown state lives
    // where every one of this feature's fetches now originates.
    const second = await resolve(`${base}/other-page`);
    expect(second.verdict).toBe('backoff');
    expect(hits).toEqual(['/limited']);
  });
});
