// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The resolver's origin-facing half: URL in, verdict out.
//
// Moved from lurker's `server/services/linkPreview.ts` (see
// lurker-dev/LINK_PREVIEWS_ISOLATION.md). What moved is everything that touches
// the origin or parses what it sent — the fetch walk, the scrape, the oEmbed
// calls, the sharp measurement. What did NOT move is everything that gives an
// answer identity and a lifetime: the cache, TTL policy, `expiresAt`, URL
// re-stamping, in-flight coalescing and descriptor minting all stay in the cell,
// next to the database that makes them mean something.
//
// So where the cell's resolver returned `unavailable()` records, this returns a
// VERDICT, and the cell decides what a verdict is worth caching for:
//
//   ok       → a card's worth of metadata (the cell computes its TTL)
//   none     → fetched fine, nothing worth showing        (cell: FAIL_TTL row)
//   refused  → we would not touch the URL                 (cell: FAIL_TTL row, warn log)
//   dead     → the origin gave us nothing usable          (cell: FAIL_TTL row)
//   backoff  → the origin asked us to slow down           (cell: transient TTL, NO row)
//
// ⚠⚠ `dead` and `backoff` must never collapse into each other. "Temporarily
// throttled" cached as "dead" blanks a perfectly good link for an hour on the
// strength of one rate-limited minute — the defect the cell's transient split
// exists to prevent, which would now be happening across a process boundary
// where it is harder to see.

import sharp from 'sharp';
import { dimensionsFromHeader } from './utils/imageHeader.js';
import {
  bufferStream,
  fetchBuffered,
  normalizeUrl,
  safeRequest,
  MAX_SCRAPE_BYTES,
  UnsafeUrlError,
  type RawResponse,
} from './services/linkFetch.js';
import { scrapeMeta, readOEmbed, decodeBody, type OEmbedMeta } from './services/linkMeta.js';
import { videoEmbedFor, oembedEndpointFor } from './services/linkEmbed.js';
import { cooldownRemaining, isTransientStatus, noteRefusal } from './utils/originCooldown.js';

/** Clamps, applied here so no client has to think about them and no cell can be
 *  surprised by a 40 KB og:description. See the ⚠ on `clamp` for why the CELL
 *  must never re-run these on unclamped input. */
const MAX_TITLE = 140;
const MAX_DESCRIPTION = 300;

/**
 * Longest URL we'll carry.
 *
 * Applies to the URL asked about AND to any og:image / oEmbed thumbnail found on the page,
 * because both end up in a response and — for the image, back in the cell — inside a minted
 * proxy token, which is base64 of the URL and therefore a third longer again. Nothing upstream
 * caps these: `normalizeUrl` is happy with a megabyte of query string, and `readOEmbed` reads a
 * `thumbnail_url` of any length straight out of a stranger's JSON. 2 KB is the de-facto ceiling
 * every browser and CDN already enforces, so anything past it wasn't going to load anyway.
 */
export const MAX_URL_LENGTH = 2048;

export type PreviewKind = 'page' | 'image' | 'video' | 'audio' | 'video-embed';

/**
 * A card's worth of metadata, in the cell's own field vocabulary.
 *
 * Nullable rather than optional ON PURPOSE: these are the exact fields of the cell's
 * `PreviewRecord`, minus identity (`url`), verdict (`status`) and lifetime (`expiresAt`),
 * which are the cell's business. Keeping the shapes aligned is what keeps the cell's half
 * of the move a re-plumbing rather than a translation layer.
 */
export interface PreviewMeta {
  kind: PreviewKind;
  title: string | null;
  description: string | null;
  siteName: string | null;
  author: string | null;
  imageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  embedUrl: string | null;
  mime: string | null;
}

export type ResolveVerdict =
  | { verdict: 'ok'; meta: PreviewMeta }
  | { verdict: 'none' }
  /** `reason` is for the CELL's log line — an SSRF refusal is either a misconfigured
   *  link or somebody probing, and the message says which. */
  | { verdict: 'refused'; reason: string }
  | { verdict: 'dead' }
  | { verdict: 'backoff'; retryAfterS: number };

/**
 * Trim and shorten a scraped string for display.
 *
 * ⚠ Cut on CODE POINTS, not on `String.prototype.slice`, which counts UTF-16 code units and
 * will happily halve a surrogate pair. A title of emoji clamped at 140 ended in a lone high
 * surrogate — which does not survive the cell's SQLite round trip, so the requester who resolved
 * the URL and everyone served from the cache afterwards got measurably different strings for the
 * same page, and a strict JSON decoder (iOS) turned it into U+FFFD. These are display clamps,
 * not byte budgets; there is no reason for them to be able to split a character.
 */
function clamp(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // ⚠ The cheap check FIRST. A code point is never fewer than one UTF-16 code unit, so
  // `length <= max` is an exact proof that no clamp is needed — and it is O(1) where
  // `Array.from` is O(n) over a string an attacker chooses the size of. `scrapeMeta` does not
  // pre-bound attribute values, so one og:description can be the whole 512 KB scrape budget.
  // In the cell this cost sat on the thread holding every IRC socket, which is the measured
  // reason (986 µs vs 2.9 µs per call) the fast path exists; here it is merely a cost, but the
  // rule survives the move because the CELL trusts these strings arrive clamped and must never
  // pay to re-clamp them.
  if (trimmed.length <= max) return trimmed;
  const points = Array.from(trimmed);
  if (points.length <= max) return trimmed;
  return `${points.slice(0, max - 1).join('')}…`;
}

/**
 * What a Content-Type means for rendering.
 *
 * SVG is deliberately absent from the image branch. It is a document format that
 * executes script, not a picture — letting one in here would hand it to clients
 * under the cell's own origin.
 *
 * ⚠ The cell keeps its own copy of this allowlist (for `cacheable()` and the byte
 * routes) — one of the two deliberate duplications in the isolation plan, and it
 * fails CLOSED: a kind one side doesn't recognise is refused, not guessed at.
 */
export function kindForContentType(contentType: string): PreviewKind | null {
  if (contentType === 'image/svg+xml') return null;
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return 'page';
  return null;
}

/** Fetch a discovered oEmbed endpoint. Best-effort: a failure just means we fall
 *  back to whatever the Open Graph tags gave us. */
async function fetchOEmbed(
  raw: string,
  base: URL,
  signal: AbortSignal,
): Promise<ReturnType<typeof readOEmbed>> {
  // ⚠ The RESOLVE is inside the try, not just the normalize — the same shape `safeRequest`
  // needed for a redirect `Location`. `raw` is an href scraped out of a stranger's markup, and
  // `new URL('http://[', base)` throws ERR_INVALID_URL while BUILDING normalizeUrl's argument,
  // so normalizeUrl's own guard never sees it. Escaping as a raw TypeError would abandon the
  // whole page — a broken oEmbed href would cost a site its preview entirely, when oEmbed is
  // the fallback path and skipping it should leave the Open Graph tags we already have.
  let url: URL | null = null;
  try {
    url = normalizeUrl(new URL(raw, base).toString());
  } catch {
    return null;
  }
  if (!url) return null;
  try {
    const res = await fetchBuffered(url, {
      accept: 'application/json',
      maxBytes: 64 * 1024,
      signal,
    });
    if (res.status !== 200) return null;
    return readOEmbed(JSON.parse(res.body.toString('utf8')));
  } catch {
    return null;
  }
}

/**
 * Assemble page metadata from whatever combination of oEmbed and scraped tags we got.
 * Returns null when there is nothing worth a card.
 *
 * ⚠ Exported for tests. The give-up rule below depends on `videoEmbedFor`, which only matches
 * real provider hosts — so the branch cannot be reached through a loopback origin, and a test
 * that goes through the HTTP surface instead exercises none of this. It stayed green with the
 * rule reverted once already, in the cell; the export came along with the code.
 */
export function pageMeta(
  url: URL,
  oembed: OEmbedMeta | null,
  meta: ReturnType<typeof scrapeMeta>,
): PreviewMeta | null {
  const embed = videoEmbedFor(url);
  const kind: PreviewKind = embed ? 'video-embed' : 'page';

  /**
   * Absolutise and vet one candidate image URL.
   *
   * og:image is routinely relative, and a relative URL resolves against the page we ACTUALLY
   * landed on, not the one we asked for — redirects move the base.
   *
   * ⚠ NOT decoded here. `scrapeMeta` and `readOEmbed` each decode entities at their own
   * boundary, and decoding is deliberately once-only — a second pass turns a literal
   * `&amp;lt;` in a filename back into `<`, and `linkMeta.test.ts` asserts the single pass.
   */
  const absolutise = (candidate: string | undefined): string | null => {
    if (!candidate) return null;
    let abs: URL | null = null;
    try {
      abs = normalizeUrl(new URL(candidate, url).toString());
    } catch {
      // `new URL` throws on input `normalizeUrl` would merely refuse — and this input came
      // from a stranger's markup, so it reaches us as anything at all.
      return null;
    }
    if (!abs) return null;
    const str = abs.toString();
    return str.length <= MAX_URL_LENGTH ? str : null;
  };

  // ⚠ Each candidate is tried in turn, rather than picking one with `||` and then vetting it.
  // Choosing first meant a page with a perfectly good og:image lost it whenever the oEmbed
  // reply carried a thumbnail_url we refuse — a data: URI, a private-address host, something
  // over-length — because by then `meta.imageUrl` had already been discarded. If the page also
  // had no title that turned into no card at all, because the OPTIONAL source was bad.
  const oembedImage = absolutise(oembed?.thumbnailUrl);
  const imageUrl = oembedImage ?? absolutise(meta.imageUrl);

  const title = clamp(oembed?.title || meta.title, MAX_TITLE);
  const description = clamp(meta.description, MAX_DESCRIPTION);

  // A card with no title and no image is a grey rectangle that says nothing.
  // Better to render the plain link the user typed.
  //
  // ⚠ ...but an embed is a card in its own right, and title/image are PAGE concepts. Without
  // the `!embed` clause a YouTube link whose provider oEmbed call failed — rate-limited, or the
  // endpoint retired, neither of which "should mean no preview at all" — fell through to the
  // scrape, found nothing because YouTube's og: tags sit past the 512 KB cap, and threw away
  // the youtube-nocookie embed URL it was already holding.
  //
  // ⚠ The CELL still owes the degraded case its shorter TTL: a record kept only by the `!embed`
  // clause has no title and no image, and `title || imageUrl` is exactly how the cell tells a
  // full card from a play-button-and-hostname one. That arithmetic stays cell-side, next to the
  // TTLs it chooses between.
  if (!title && !imageUrl && !embed) return null;

  return {
    kind,
    title,
    description,
    siteName: clamp(oembed?.providerName || meta.siteName || url.hostname, MAX_TITLE),
    author: clamp(oembed?.authorName, MAX_TITLE),
    imageUrl,
    // ⚠ Only when the oEmbed thumbnail is the image we actually took. `thumbnail_width` and
    // `thumbnail_height` describe `thumbnail_url` and nothing else, so pairing them with an
    // og:image that won instead reserves a box of the wrong shape — a 4:3 hole for a 16:9
    // picture — which is precisely the reflow these fields exist to prevent.
    //
    // ⚠ The other branch is the SCRAPED image's own `og:image:width`/`og:image:height`, which
    // `scrapeMeta` gates on that same image having won its own ladder. These are what decide
    // between a hero band and a 72px square on the card, so the pairing rule matters twice
    // over: measured against the wrong picture, a logo gets a hero and an article gets a chip.
    imageWidth: oembedImage ? (oembed?.thumbnailWidth ?? null) : (meta.imageWidth ?? null),
    imageHeight: oembedImage ? (oembed?.thumbnailHeight ?? null) : (meta.imageHeight ?? null),
    embedUrl: embed?.embedUrl ?? null,
    mime: null,
  };
}

/** Resolve an HTML page into a card by scraping it. */
async function resolveScrapedPage(
  url: URL,
  body: Buffer,
  charset: string | null,
  signal: AbortSignal,
): Promise<PreviewMeta | null> {
  // ⚠ The declared CHARSET, not the Content-Type header. `decodeBody` used to re-parse
  // `charset=…` out of what it was handed, but what reached it was `RawResponse.contentType`,
  // already stripped to a bare `text/html` — a branch that could never match, so
  // `charset=windows-1251` with no in-document `<meta charset>` fell through to UTF-8 and
  // rendered as replacement characters. `BufferedResponse` carries the parsed charset as its
  // own field for exactly this call.
  const html = decodeBody(body, charset);
  const meta = scrapeMeta(html);

  // Discovered oEmbed still wins over the scraped tags where a page advertises one, matching
  // Slack: it's a structured, versioned answer from the site itself rather than a bag of
  // strings. This is the discovery path, for sites not in the provider table.
  const oembed = meta.oembedUrl ? await fetchOEmbed(meta.oembedUrl, url, signal) : null;
  return pageMeta(url, oembed, meta);
}

/**
 * Pixel dimensions of an image, from as few bytes as we can get away with.
 *
 * Purely so clients can reserve the right amount of space *before* the bytes arrive. Without
 * it a message list grows twice — once when the metadata lands and again when the image
 * decodes — and in a bottom-anchored chat log the second one yanks the reader off the live
 * tail. With an aspect ratio in hand the box is allocated at metadata time and the image
 * simply appears inside it.
 *
 * A header-sized read is enough for every format that matters: the dimensions live in the
 * first few hundred bytes of a JPEG/PNG/GIF/WebP. Failure is fine (an exotic format, a header
 * sharp can't make sense of) — the client falls back to a reserved box, which costs a little
 * space rather than a layout jump.
 *
 * ⚠⚠ SHARP ALONE IS NOT ENOUGH, and the reason is counter-intuitive: it is not that the header
 * is truncated — every format here puts its dimensions in the first few dozen bytes — it is that
 * some containers declare a TOTAL LENGTH and their loaders refuse a file shorter than it claims,
 * before decoding anything. Measured at this exact cap: png, jpeg and avif read fine; webp, gif
 * and tiff all throw. No sharp option relaxes it (`failOn: 'none'` and `failOn: 'truncated'` both
 * still throw), because the rejection is above the decoder.
 *
 * QA saw this as "solo .webp images get a grey background but .png ones don't" — a size-specific
 * bug wearing a format-specific costume, since a WebP under 64 KB was measured correctly. The
 * fallback reads the two fields directly for the two formats that are ordinary to paste into IRC.
 */
async function imageDimensions(
  res: RawResponse,
): Promise<{ width: number; height: number } | null> {
  try {
    const head = await bufferStream(res, { maxBytes: 64 * 1024 });
    return await dimensionsFromHead(head.body);
  } catch {
    // The read itself failed. No dimensions means no reservation, not no preview.
  }
  return null;
}

/**
 * The measuring half, split out from the stream read so it can be TESTED.
 *
 * ⚠ Exported for the test alone, and that is worth one line of module surface: the resolver's
 * only route to real image bytes is a network fetch, and the SSRF guard blocks loopback by
 * design — so nothing that goes through `resolveUrl` can hand this function a real photo.
 * Un-split, the EXIF rule below was a claim backed by a console probe and by nothing that runs.
 */
export async function dimensionsFromHead(
  body: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const meta = await sharp(body).metadata();
    // ⚠⚠ `autoOrient`, NOT `width`/`height`. sharp reports the dimensions as STORED; a browser
    // decodes with `image-orientation: from-image` and applies the EXIF rotation, so for the
    // most ordinary photo on the platform — a phone JPEG with orientation 6 — the two disagree
    // by a transpose. Measured on the sharp in this tree: stored 400x300, `autoOrient`
    // {300,400}, and `.rotate()` (what the browser effectively does) 300x400.
    //
    // These numbers are a LAYOUT PROMISE, not a statistic: the client reserves the box from
    // this ratio before any bytes arrive (MessageAttachment's `reserveStyle`), so a transposed
    // pair means a portrait photo sits letterboxed in a landscape box — and on a column narrow
    // enough for `max-width` to bite, the wrong ratio drags the reserved height down with it.
    const dims = meta.autoOrient ?? meta;
    if (dims.width && dims.height) return { width: dims.width, height: dims.height };
  } catch {
    // Fall through: sharp refusing a truncated container is the case below, not a dead end.
  }
  // ⚠ Second, never first. sharp handles more formats and is the better answer wherever it
  // works; this must not shadow it with a narrower implementation that could disagree.
  // ⚠ This fallback reads stored dimensions and knows nothing of EXIF, so it can still return a
  // transposed pair. It is reached only for a container sharp refuses at 64 KB — webp, gif and
  // tiff — and the orientation tag in the wild is a JPEG phenomenon, which sharp measures.
  return dimensionsFromHeader(body);
}

/** The backoff the origin asked for, or a minute when it refused without saying. */
function backoff(host: string): ResolveVerdict {
  return { verdict: 'backoff', retryAfterS: cooldownRemaining(host) || 60 };
}

async function doResolve(raw: string, signal: AbortSignal): Promise<ResolveVerdict> {
  const url = normalizeUrl(raw);
  if (!url) return { verdict: 'refused', reason: 'disallowed or malformed URL' };
  // ⚠ Re-checked on the NORMALISED form. The cell gates the request string, but WHATWG
  // percent-encoding expands every non-ASCII byte threefold, so a 2,014-character URL of
  // Cyrillic passes that gate and comes out of `normalizeUrl` at 12,014 — and back in the cell
  // the image URL is stored verbatim and minted into a proxy path a third longer again, past
  // node's own 16 KB header ceiling on the request that would fetch it. Measured, not theorised.
  if (url.toString().length > MAX_URL_LENGTH) {
    return { verdict: 'refused', reason: 'URL too long once normalised' };
  }

  // A host that recently told us to stop is not asked again until it says we may. The cooldown
  // state lives HERE now — every fetch this feature makes goes through this process, so this is
  // the one place a refusal is always seen. (In the cell this gate only guarded the byte proxy;
  // the resolve path re-asking a 429ing host was the gap.)
  const cooling = cooldownRemaining(url.hostname);
  if (cooling > 0) return { verdict: 'backoff', retryAfterS: cooling };

  // Known providers are asked directly, BEFORE anything is fetched from the page itself.
  // For YouTube this is the difference between working and not: its og: tags sit past
  // half a megabyte of inline script, while its oEmbed endpoint answers in under a
  // kilobyte. See `oembedEndpointFor`.
  const endpoint = oembedEndpointFor(url);
  if (endpoint) {
    const oembed = await fetchOEmbed(endpoint, url, signal);
    if (oembed?.title) {
      const meta = pageMeta(url, oembed, {});
      if (meta) return { verdict: 'ok', meta };
    }
    // Fall through and scrape. A provider can be down, or rate-limiting us, or have
    // retired an endpoint — none of which should mean no preview at all.
  }

  const res = await safeRequest(url, { signal });
  if (res.status !== 200) {
    res.stream.destroy();
    // ⚠ "Not now" and "not ever" are different answers. A 429/503 is the origin managing its
    // own load, and it usually says for how long — collapsing that into `dead` banks one busy
    // minute for the length of the cell's failure TTL.
    if (isTransientStatus(res.status)) {
      noteRefusal(url.hostname, res.headers);
      return backoff(url.hostname);
    }
    return { verdict: 'dead' };
  }

  const kind = kindForContentType(res.contentType);
  if (kind === null) {
    res.stream.destroy();
    return { verdict: 'dead' };
  }

  // Direct media: the URL IS the content, so there's nothing to scrape. For an image we
  // read a header's worth to learn its dimensions — see `imageDimensions` for why that
  // matters more than it looks — and for video/audio we stop at the headers, since the
  // cell's clients ask for bytes separately and only if something actually renders.
  if (kind !== 'page') {
    const size = kind === 'image' ? await imageDimensions(res) : null;
    res.stream.destroy();
    return {
      verdict: 'ok',
      meta: {
        kind,
        title: null,
        description: null,
        siteName: null,
        author: null,
        imageUrl: url.toString(),
        imageWidth: size?.width ?? null,
        imageHeight: size?.height ?? null,
        embedUrl: null,
        mime: res.contentType,
      },
    };
  }

  // Buffered off the response we already have, rather than re-requesting: a second GET for
  // the body doubled every page fetch, and doubled the chance of a rate limit on a host we
  // want to stay welcome at. `stopAtHeadEnd` means a well-formed page costs its head only.
  const buffered = await bufferStream(res, {
    maxBytes: MAX_SCRAPE_BYTES,
    stopAtHeadEnd: true,
  });
  const meta = await resolveScrapedPage(buffered.finalUrl, buffered.body, buffered.charset, signal);
  return meta ? { verdict: 'ok', meta } : { verdict: 'none' };
}

/**
 * Resolve one URL to a verdict. Never throws.
 *
 * The caller owns concurrency and the overall deadline (see server.ts) and hands in the
 * signal that makes giving up real — an abandoned fetch keeps its socket for its own hop
 * budget, and only an ABORTED one frees the slot honestly.
 */
export async function resolveUrl(raw: string, signal: AbortSignal): Promise<ResolveVerdict> {
  try {
    return await doResolve(raw, signal);
  } catch (err) {
    // ⚠ Every UnsafeUrlError maps to `refused`, and that is the cell's CURRENT semantics, not a
    // simplification: the cell logged and FAIL_TTL'd the whole class — guard refusals and hop
    // timeouts alike — through one branch. The message rides along so the cell's warn line
    // ("misconfigured link or somebody probing") stays as informative as it was in-process.
    if (err instanceof UnsafeUrlError) {
      return { verdict: 'refused', reason: err.message };
    }
    // Timeouts, resets, unresolvable hosts — ordinary internet weather. A verdict about the
    // URL as of now, which the cell caches for its ordinary failure TTL.
    return { verdict: 'dead' };
  }
}
