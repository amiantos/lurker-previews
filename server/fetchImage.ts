// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The byte half: fetch one image from its origin and stream it to the cell.
//
// Moved from the origin-facing side of lurker's `server/routes/linkPreview.ts`.
// What stayed in the cell is everything client-facing: the proxy token, auth,
// throttles, the byte cache and its writer, and the security headers a browser
// sees. This end answers with the ORIGIN's status and bytes, precisely mapped —
// the cell translates for <img> consumers (where, e.g., our 502 becomes its 404,
// because an <img> treats 404 as permanent and that is the verdict a dead origin
// has earned; a 503 stays 503 so the element retries).
//
// ⚠ Every guard in here carries the bug that earned it, in the comment above it.
// They moved verbatim; see lurker-dev/LINK_PREVIEWS_ISOLATION.md.

import type { ServerResponse } from 'node:http';
import { normalizeUrl, safeRequest, UnsafeUrlError } from './services/linkFetch.js';
import { cooldownRemaining, isTransientStatus, noteRefusal } from './utils/originCooldown.js';
import { kindForContentType } from './resolve.js';
import { SlotPool } from './utils/slotPool.js';

/** Ceiling on preview IMAGE bytes we will relay — the only kind we relay at all. */
export const MAX_IMAGE_PROXY_BYTES = 8 * 1024 * 1024;

/**
 * Whether we will serve this content type.
 *
 * ⚠ Derived from `kindForContentType` rather than restated. The cell's route once had its own
 * copy of the same allowlist, which meant the refusal that matters most — `image/svg+xml`, a
 * scripting format wearing a picture's clothes — existed in two places that had to be kept in
 * step by hand.
 *
 * ⚠⚠ IMAGES ONLY. Video and audio are not relayed at any size (the media policy —
 * LINK_PREVIEWS_MEDIA_POLICY.md). The cell stops minting byte URLs for those kinds, so nothing
 * should ask — but this is the enforcement point, and it has to refuse a replayed request from
 * a cell holding an older descriptor.
 */
export function proxyableContentType(contentType: string): boolean {
  return kindForContentType(contentType) === 'image';
}

/**
 * Byte fetches in flight across the whole service.
 *
 * The higher-volume half: one resolve per link, but one byte request per image a client
 * actually renders. It is also what bounds this process's outstanding `getaddrinfo` calls —
 * they run on libuv's thread pool and CANNOT be cancelled, so a destroyed request keeps its
 * slot for the full OS timeout. In the cell that pool was shared with IRC connection setup,
 * which is the starvation this whole service exists to end; here the worst case is previews
 * getting slower, which is the correct process to pay that cost.
 *
 * Separate from the resolve pool because the two have opposite profiles: a metadata fetch is a
 * sub-second burst, a byte fetch holds its slot for the length of a transfer. Sharing would let
 * a run of slow image origins stall every resolve on the instance.
 */
const fetchPool = new SlotPool({ size: 24, maxQueued: 200, waitMs: 3_000 });

/**
 * Ceiling on one relayed transfer, start to finish.
 *
 * ⚠ `streaming: true` clears HOP_DEADLINE_MS, which is the only bound in the fetcher that a
 * byte cannot reset — deliberately, because it cut healthy transfers at 20 s. But that leaves
 * this path with NO total-time bound: an origin dribbling one byte every 25 s resets the idle
 * timer forever, never reaches the byte counter's cap, and holds a pool slot indefinitely.
 *
 * Generous on purpose — 8 MB inside five minutes is well under any real server-to-origin link —
 * so it bounds abuse without cutting a slow-but-genuine transfer.
 */
const MAX_TRANSFER_MS = 5 * 60_000;

/**
 * Total size of the resource a `Content-Range` describes.
 *
 * Returns a number, `'unknown'` when the origin legitimately doesn't say (`bytes 0-N/*`, which
 * RFC 7233 §4.2 allows), or `'unusable'` for anything we can't make sense of.
 *
 * ⚠ Three ways the first version let the cap be walked past, and the shape of two of them is
 * worth keeping in mind: **the more absurd the claim, the more permissive the answer.**
 *   - `bytes 0-N/*` matched nothing (the pattern demanded digits), so an origin that declines
 *     to state a size got waved through.
 *   - A 400-digit total made `Number()` return `Infinity`, `Number.isFinite` false, and the
 *     guard conclude "no total, carry on". Now it fails CLOSED.
 *   - `$`-anchoring read only the last of a duplicated header, which node joins with a comma.
 */
export function contentRangeTotal(header: string | undefined): number | 'unknown' | 'unusable' {
  if (!header) return 'unknown';
  // node joins duplicate headers with ', '. Judge the FIRST — an origin repeating itself gets
  // read the way a client would read it, not the way an attacker would prefer.
  const first = header.split(',')[0];
  const slash = first.lastIndexOf('/');
  if (slash === -1) return 'unusable';
  const total = first.slice(slash + 1).trim();
  if (total === '*') return 'unknown';
  if (!/^\d+$/.test(total)) return 'unusable';
  const n = Number(total);
  // Past 2^53 the digits are real but the number isn't; a length we can't represent is a
  // length we refuse rather than one we ignore.
  return Number.isSafeInteger(n) ? n : 'unusable';
}

/**
 * Fetch `rawUrl` and stream the image back on `res`. Owns its status codes end to end;
 * the caller has already parsed the request body and done nothing else.
 */
export async function fetchImage(
  res: ServerResponse,
  rawUrl: string,
  range: string | undefined,
): Promise<void> {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('refused');
    return;
  }

  // ⚠⚠ A host that just rate-limited us is not asked again until it says we may.
  // Measured on a real instance: `opengraph.githubassets.com` — where every GitHub link's
  // og:image lives — advertises a budget of 100 in `x-ratelimit-*`, and a channel with a run
  // of GitHub links spends it in one burst from the instance's single IP. Without this, every
  // later view of every one of those images went out and asked again, so the budget never
  // recovered.
  //
  // ⚠ Checked BEFORE the pool, deliberately: the whole point is to spend nothing — not a
  // slot, not a socket, not a DNS lookup — on a request we already know the answer to.
  const cooling = cooldownRemaining(url.hostname);
  if (cooling > 0) {
    res.writeHead(503, { 'retry-after': String(cooling) }).end();
    return;
  }

  if (!(await fetchPool.acquire())) {
    // Saturated, not broken. 503 + Retry-After so the cell (and the media element behind it)
    // backs off and retries, rather than a status anything treats as a permanent verdict.
    res.writeHead(503, { 'retry-after': '5' }).end();
    return;
  }

  // ⚠ Registered BEFORE the fetch is awaited, and it owns the slot release.
  //
  // Attaching this after `await safeRequest(...)` — which can take the full hop deadline —
  // meant a caller that aborted during the fetch had already fired `close`, so the listener
  // written to stop us holding a socket to the origin was attached to an event that would
  // never fire again. The whole body then drained to the origin's end with nobody to send it
  // to: connect-then-abort as a cheap amplifier.
  //
  // ⚠⚠ The abort is what makes this work: aborting the CONTROLLER covers the window before
  // there is a stream to destroy. `close` on a response fires whether it finished or aborted,
  // which makes it the one place that always runs — so it is also where the pool slot goes back.
  const controller = new AbortController();
  let upstream: Awaited<ReturnType<typeof safeRequest>> | null = null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(transferDeadline);
    controller.abort();
    upstream?.stream.destroy();
    fetchPool.release();
  };
  // Bounds slot occupancy even when nothing else will — see MAX_TRANSFER_MS. Tearing the
  // response down routes through `release` via `close`, so there is still one release path.
  const transferDeadline = setTimeout(() => {
    upstream?.stream.destroy();
    res.destroy();
  }, MAX_TRANSFER_MS);
  transferDeadline.unref();

  res.on('close', release);
  // A response already gone by the time we got a slot never emits `close` again.
  // ⚠ The RESPONSE only. The request stream reads as `destroyed` here in the ordinary
  // course of things — node closes an IncomingMessage the moment its body is fully
  // consumed, which the JSON parse upstream of this call has always already done — so
  // testing it reported every single request as abandoned and silently answered nothing.
  if (res.destroyed) {
    release();
    return;
  }

  try {
    upstream = await safeRequest(url, {
      // ⚠ Images only — everything else is refused at `proxyableContentType` below, so asking
      // for video/audio would only invite a body we are going to destroy at its headers.
      accept: 'image/*,*/*;q=0.5',
      // ⚠ Still forwarded. An origin may answer a plain GET with a 206 of its own accord, and
      // a request that arrives with a Range must be asked about the SAME bytes the client
      // wants — not silently answered from byte zero.
      range,
      // Piped, not buffered: the scrape-tuned deadlines cut a healthy media transfer at 20 s
      // and read a backpressured reader as a dead origin. See FetchOptions.streaming.
      streaming: true,
      // So giving up actually ends the fetch. Without it the release above frees a slot while
      // the request is still dialling — including an uncancellable lookup — which is the
      // undercount this pool exists to prevent.
      signal: controller.signal,
    });
    // The caller left, or the stream died, while we were awaiting. Without this the response
    // never gets its `end()`, so the cell hangs on a half-open response with no error to show.
    if (released || res.destroyed || upstream.stream.destroyed) {
      // ⚠ Destroyed HERE, not delegated to `release()`. If the caller left during the fetch,
      // `release()` has already run and latched — calling it again returns at its own guard
      // and the stream we have only just been handed stays open, unread, until an idle
      // timeout the streaming flag has already loosened to 30 s.
      upstream.stream.destroy();
      release();
      return;
    }

    // 206 is a success here: it's what a range request is asking for. 416 is the origin
    // telling the client its range is unsatisfiable, which is an answer the media element
    // (two hops away) knows how to act on — collapsing it makes an unsatisfiable seek look
    // like a missing file.
    if (upstream.status === 416) {
      upstream.stream.destroy();
      const head: Record<string, string> = {};
      if (upstream.headers['content-range']) {
        head['content-range'] = String(upstream.headers['content-range']);
      }
      res.writeHead(416, head).end();
      return;
    }
    const ok = upstream.status === 200 || upstream.status === 206;
    if (!ok || !proxyableContentType(upstream.contentType)) {
      upstream.stream.destroy();
      // ⚠⚠ "Not now" and "not ever" are different answers, and collapsing them is what made a
      // GitHub rate limit look like a missing image for a day. Only the STATUS gets the
      // transient treatment: a content type we refuse to relay is a fact about the URL and
      // stays a 404 however many times it is asked.
      if (ok || !isTransientStatus(upstream.status)) {
        res.writeHead(404).end();
        return;
      }
      // The host's own instruction is preferred over any guess we could make —
      // `Retry-After` in either legal form, else `x-ratelimit-reset`.
      noteRefusal(url.hostname, upstream.headers);
      res.writeHead(503, { 'retry-after': String(cooldownRemaining(url.hostname) || 60) }).end();
      return;
    }
    // ⚠⚠ NOTHING clears the hold on success, and that is deliberate — a `noteSuccess` here
    // would be both dead (an active hold short-circuits above, so no fetch reaches this line
    // while one is armed) and harmful (the one interleaving that DOES reach it is the burst
    // this exists to damp: several refusals arm the hold and a single straggler's success
    // tears it down before it can stop anything). The hold expires on its own clock.
    const cap = MAX_IMAGE_PROXY_BYTES;
    const declared = Number(upstream.headers['content-length']);
    // ⚠ On a 206 the declared length is the length of the PART, so checking it alone lets the
    // cap be walked straight past: a client asking for a gigabyte 1 MB at a time satisfies
    // `declared <= cap` every single time. The resource's real size is the figure after the
    // slash in Content-Range, and that is what the cap is about.
    const total = contentRangeTotal(upstream.headers['content-range'] as string | undefined);
    const oversize =
      (Number.isFinite(declared) && declared > cap) ||
      total === 'unusable' ||
      (typeof total === 'number' && total > cap);
    if (oversize) {
      upstream.stream.destroy();
      res.writeHead(413).end();
      return;
    }

    const head: Record<string, string> = {
      'content-type': upstream.contentType,
    };
    // ⚠⚠ FRAMING ATTESTATION, and it exists because a relay LAUNDERS truncation. An origin
    // body framed only by the connection closing (no Content-Length, not chunked — which
    // linkFetch's keepAlive:false makes ordinary, since every request carries
    // `Connection: close`) reaches this process as a COMPLETE stream: to the protocol, EOF
    // is the terminator, and a cut body is indistinguishable from a finished one. Relaying
    // it re-frames the bytes as clean chunked, so the cell's cache guard — which must never
    // store a possibly-truncated image under `immutable` — would see nothing wrong. This
    // header carries the evidence across the seam: present iff the ORIGIN's framing was
    // verifiable. Truncation of a VERIFIABLE body still shows up mechanically (a cut
    // chunked stream, a Content-Length mismatch), so presence is all the cell needs.
    const chunkedOrigin = String(upstream.headers['transfer-encoding'] ?? '')
      .toLowerCase()
      .includes('chunked');
    if (chunkedOrigin || Number.isFinite(declared)) {
      head['x-lurker-origin-framed'] = '1';
    }
    // Range plumbing. ⚠ Only claimed when the origin actually demonstrated it: advertising
    // `Accept-Ranges: bytes` for a source that ignores Range makes a media element seek by
    // requesting a range and then silently receive the whole file from byte zero.
    // ⚠ A TOKEN match. node joins a duplicated header, so a range-capable origin that sends
    // `Accept-Ranges: bytes` twice arrives as `'bytes, bytes'` and an equality test calls it
    // range-incapable.
    const upstreamRanges =
      upstream.status === 206 ||
      String(upstream.headers['accept-ranges'] || '')
        .toLowerCase()
        .split(',')
        .some((token) => token.trim() === 'bytes');
    if (upstreamRanges) head['accept-ranges'] = 'bytes';
    if (upstream.headers['content-range']) {
      head['content-range'] = String(upstream.headers['content-range']);
    }
    // ⚠ Content-Length is only forwarded when we KNOW we'll send exactly that many bytes.
    // Echoing it verbatim while the body was truncated at the cap produces a length/body
    // mismatch — the cell sees a broken transfer rather than a clean failure.
    if (Number.isFinite(declared) && declared <= cap) {
      head['content-length'] = String(declared);
    }
    res.writeHead(upstream.status === 206 ? 206 : 200, head);

    // Enforce the cap on bytes actually seen, not on the declared length — an
    // origin can omit Content-Length or lie about it.
    let sent = 0;
    const stream = upstream.stream;
    stream.on('data', (chunk: Buffer) => {
      sent += chunk.length;
      if (sent > cap) {
        stream.destroy();
        res.destroy();
      }
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (err) {
    release();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // The guard's refusal is the one distinction worth carrying: the cell logs those. A
    // timeout, a reset, an unresolvable host are all the same dead origin to a caller
    // waiting on an image.
    if (err instanceof UnsafeUrlError) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('refused');
      return;
    }
    res.writeHead(502).end();
  }
}
