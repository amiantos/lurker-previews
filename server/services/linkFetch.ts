// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The outbound half of link previews: fetching a URL that an arbitrary IRC user
// pasted, from a server that sits inside a VPC, without becoming an SSRF hole or
// a memory hazard.
//
// On node:http/https rather than fetch, for two reasons — one shared with the
// uploader and one specific to here:
//
//   1. DNS pinning needs a custom `lookup`, and fetch/undici gives no equivalent
//      hook. Without it, "validate the hostname, then connect" is a TOCTOU bug:
//      DNS rebinding makes the second resolution return 127.0.0.1 and the guard
//      you wrote never sees it. See `pinnedLookup` below.
//   2. undici buffers, and buffering a response whose size we don't trust is the
//      whole problem. Streaming with a running byte counter is the point.
//
// Everything here fails CLOSED. A malformed URL, an unresolvable host, an
// unexpected content-encoding, a redirect we can't re-validate — all of it ends
// as `null`/throw, never as "well, try connecting and see".

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import type { IncomingMessage } from 'node:http';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { isBlockedIpLiteral } from '../utils/ipGuard.js';
import { APP_NAME, APP_VERSION, USER_AGENT_CONTACT } from '../utils/userAgent.js';

/**
 * Idle timeout: node arms this as `socket.setTimeout`, which every arriving byte resets. It
 * bounds a STALL — a dead connect, headers that never come — and not the transfer.
 */
const IDLE_TIMEOUT_MS = 5000;

/**
 * Hard ceiling on one hop, start to finish, however busy it looks.
 *
 * ⚠ The idle timer alone is not a budget, and the gap is exploitable rather than theoretical:
 * an origin dribbling one byte every four seconds resets it forever, so a 512 KB read could
 * hold a socket for weeks. This one is never reset, so a fetch is bounded at MAX_REDIRECTS + 1
 * hops of it. Verified against a real dribbling origin: cut at ~20 s, with the prefix that had
 * arrived returned and flagged `truncated`.
 */
const HOP_DEADLINE_MS = 20_000;

/**
 * Idle allowance once a STREAMING consumer has its headers — see `FetchOptions.streaming`.
 *
 * ⚠ Both of the bounds above are wrong for a body that is piped rather than buffered.
 * `HOP_DEADLINE_MS` is cleared on the request's `close`, which does not fire during a body
 * transfer, so any response still streaming at 20 s was cut. And `IDLE_TIMEOUT_MS` fires on a
 * backpressured pipe: a consumer that has filled its buffer and stopped reading is behaving
 * normally, but no bytes move and the socket times out.
 *
 * ⚠ The example this was written for is gone: the ceiling it named (`MAX_MEDIA_PROXY_BYTES`,
 * 64 MB, needing ~26 Mbit/s sustained to land inside 20 s) belonged to inline video, which the
 * proxy no longer relays at all. The bound still earns its place for images — 8 MB over a slow
 * link crosses 20 s easily — so what changed is the size of the problem, not its shape.
 *
 * So a streaming caller keeps the deadline for connect-and-headers — the part that can hang
 * with nothing to show for it — and then trades it for this, which bounds a genuinely dead
 * origin while tolerating a reader that has paused.
 *
 * ⚠ A cut here is recoverable only where the ORIGIN supports ranges, and this comment used to
 * claim it always was — "the proxy forwards Accept-Ranges, so a media element re-requests the
 * range it still wants" — which the sibling change in the same commit falsified by making that
 * header conditional on the origin having demonstrated range support. For a dumb, slow origin
 * that advertises nothing, which is exactly the profile most likely to idle out here, the
 * client is told ranges are unavailable and cannot resume. That is the honest position: this
 * bound trades a stalled socket for a broken transfer, and the trade is only clearly right
 * because the alternative is holding a pool slot forever.
 */
const STREAM_IDLE_TIMEOUT_MS = 30_000;

/** Redirects followed before giving up. Each hop is re-validated. */
const MAX_REDIRECTS = 3;

/**
 * How much of an HTML document we read before giving up on finding metadata.
 *
 * Generous, because `stopAtHeadEnd` means a well-formed page costs its head and not a byte
 * more — the ceiling only binds on documents that bury their metadata, and for those the
 * choice is a large read or no preview. The Lounge defaults to 50 KB and had to expose a
 * config knob when YouTube pushed its og: tags past 300 KB; Slack asks for the first 32 KB
 * via a Range header and silently misses anything later.
 *
 * Note this is NOT the YouTube fix. Sites that hide their metadata behind half a megabyte of
 * inline script get asked directly, via their oEmbed endpoint, rather than scraped — no cap
 * large enough to scrape YouTube would be a sane thing to apply to the whole web.
 */
export const MAX_SCRAPE_BYTES = 512 * 1024;

/**
 * What we tell the origin we are.
 *
 * We are not a crawler. We fetch one URL, once, because a person pasted it in a
 * channel and another person is looking at it — which is exactly the traffic
 * class the social-preview user-agents denote, and exactly the class sites
 * deliberately serve, because a preview card is free distribution. It is
 * categorically not what "block AI crawlers" is aimed at; that's bulk
 * training-data scraping.
 *
 * The two shipped implementations we have to compare against both reached the
 * same conclusion: The Lounge sends `facebookexternalhit/1.1 Twitterbot/1.0`,
 * halloy defaults to `WhatsApp/2` "for wide compatibility". We lead with our own
 * identity and a contact URL, then name the class, so an operator reading their
 * logs can tell exactly who we are and block us on purpose if they want to.
 *
 * Overridable because reasonable operators will disagree, and because the string
 * that gets served will drift over time.
 *
 * Distinct from the app-wide `USER_AGENT` on purpose — that one is a plain
 * `Lurker/x.y (+contact)` for talking to upload providers, and naming the
 * social-preview class is exactly what we do NOT want on those. It shares the
 * version and the operator's contact override, so a deployment identifies itself
 * consistently and neither string goes stale on its own.
 */
export function userAgent(): string {
  const override = process.env.LURKER_PREVIEW_USER_AGENT;
  if (override) return override;
  const contact = USER_AGENT_CONTACT ? `; +${USER_AGENT_CONTACT}` : '';
  return `Mozilla/5.0 (compatible; ${APP_NAME}/${APP_VERSION}${contact}) facebookexternalhit/1.1`;
}

export class UnsafeUrlError extends Error {}

/**
 * Parse and vet a URL string before anything dials it.
 *
 * Rejects non-http(s) schemes (`file:`, `gopher:`, and friends have no business
 * here), embedded credentials (which a redirect would happily carry somewhere
 * else), and hosts that are *literally* an internal address. A hostname that
 * merely resolves to one is caught later, at connect time — see `pinnedLookup`.
 */
export function normalizeUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;

  // `new URL` keeps IPv6 literals bracketed; the guard wants the bare address.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Only judge things that are already addresses. A name gets judged by what it
  // resolves to, which is a question for connect time, not parse time.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    if (isBlockedIpLiteral(host)) return null;
  }

  // The fragment is client-side only and never reaches the origin; dropping it
  // means `#a` and `#b` share one cache entry instead of two.
  url.hash = '';
  return url;
}

/**
 * A `lookup` that resolves once, refuses internal addresses, and hands node the
 * exact address it approved.
 *
 * This is the pin. node connects to whatever this callback yields, so there is
 * no second resolution for an attacker's short-TTL record to win — the classic
 * DNS-rebinding SSRF (validate `evil.com` → A 1.2.3.4, connect → A 127.0.0.1)
 * has nowhere to happen. Validating a hostname anywhere else in this file would
 * be theatre.
 *
 * Typed as node's own `net.LookupFunction`, which is the contract this has to
 * satisfy — the two shapes of callback below aren't ours to choose.
 */
const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  // node wants ONE address, or ALL of them when it intends to race the families — which is
  // what it actually asks for here, `autoSelectFamily` having been on by default since node
  // 20. Both shapes have to be answered in kind, or node reads back the wrong thing.
  const wantAll = options.all === true;
  // The options are node's to decide, and forwarding them is not just tidiness: it hands us
  // `hints: ADDRCONFIG`, meaning "only answer with families this host has configured". Dropping
  // that lets the pin approve an address the connection could never have used — a working fetch
  // turned into a failed one on a v4-only box. Same for a `family` a future caller sets.
  //
  // `all` is forced on regardless of what was asked: every answer has to be judged, not just
  // whichever one node would have picked.
  dns.lookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    // node never reads the address when the error is set; its own lookup passes nothing.
    if (err) return callback(err, '');
    const safe = addresses.filter((a) => !isBlockedIpLiteral(a.address));
    if (safe.length === 0) {
      const e: NodeJS.ErrnoException = new UnsafeUrlError(
        `refusing to connect to ${hostname}: resolves only to internal addresses`,
      );
      e.code = 'EACCES';
      return callback(e, '');
    }
    if (wantAll) return callback(null, safe);
    callback(null, safe[0].address, safe[0].family);
  });
};

/**
 * Dedicated connection pools. **Never `globalAgent`.**
 *
 * A reused socket skips DNS entirely — which means it skips `pinnedLookup`,
 * which means it skips the guard. `http.globalAgent` has been keep-alive by
 * default since node 19 and is shared with every other part of the process, so
 * using it would let a socket that something else opened, to a host we never
 * vetted, be handed to a preview fetch. That is not hypothetical: it is how this
 * was found, when a test probe's pooled socket got reused by the fetcher and the
 * lookup never ran — the guard tests below dial their origin first, exactly so a
 * warm socket is sitting in the pool when they assert the refusal.
 *
 * A private agent with keep-alive off means every request we make goes through
 * the pin, every time. Preview fetching is not a hot path; correctness of the
 * guard is worth one handshake.
 *
 * ⚠⚠ The invariant is `keepAlive: false` AND an UNBOUNDED `maxSockets` — both halves, which is
 * why the second is spelled out rather than left to the default. node only marks a request
 * `shouldKeepAlive = false` when `!agent.keepAlive && !isFinite(agent.maxSockets)`, and the
 * Agent's `free` handler hands a released socket to a queued same-host request BEFORE it ever
 * consults `keepAlive`. So capping these — the obvious way to bound preview concurrency — would
 * quietly restore socket reuse and put the DNS-pin bypass straight back. Measured: 6 concurrent
 * requests through `{keepAlive: false}` do 6 lookups; through `{keepAlive: false, maxSockets: 2}`
 * they do 2. Bound concurrency in the CALLER, above this module.
 */
const httpAgent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: Infinity });

export interface FetchOptions {
  /** `Accept` header. Defaults to a browser-ish HTML preference. */
  accept?: string;
  /** A `Range` header to forward, so the byte proxy can serve partial content. Media elements
   *  require it: Safari won't play a <video> from a source that ignores ranges. */
  range?: string;
  /**
   * This caller will PIPE the body rather than buffer it.
   *
   * Swaps the hop deadline for `STREAM_IDLE_TIMEOUT_MS` once the response headers arrive. The
   * defaults are tuned for a 512 KB scrape that completes in one burst, and applied to a media
   * stream they cut a healthy transfer at 20 s and treat a paused reader as a dead origin.
   * Connect and headers stay bounded by the deadline either way — that is the phase where a
   * hostile host can hang us with nothing to show for it.
   */
  streaming?: boolean;
  /**
   * Tears the request down when it fires.
   *
   * ⚠ Without this, a caller that gives up on a fetch does not stop the fetch. That matters
   * wherever giving up also releases a resource: the resolver bounds one URL's whole resolution
   * and then frees its pool slot, so an abandoned-but-still-running request meant the pool
   * undercounted its own work and more than MAX_CONCURRENT fetches could be live at once —
   * under a run of slow origins, without bound. Abandoning work is not the same as ending it,
   * and only the second one makes a concurrency cap mean anything.
   *
   * What it does NOT cancel is a pending `getaddrinfo`: node offers no way to, so a lookup
   * keeps its libuv slot until the OS gives up. That gap is documented where it bites, on the
   * resolver's pool.
   */
  signal?: AbortSignal;
  // ⚠ No byte ceiling here. It reads like it belongs — but nothing on this path consumes a
  // body, so nothing could enforce it, and an option that documents a guarantee it doesn't
  // provide is worse than no option. The cap lives in `BufferOptions`, where the read is.
}

/** The bare MIME type, plus the charset the origin declared alongside it. */
interface ContentType {
  /** Lowercased, parameters stripped: `text/html`. */
  contentType: string;
  /**
   * The declared charset, lowercased, or null.
   *
   * Kept as its own field because `contentType` throws the parameters away, and a caller
   * decoding a body needs it: `text/html; charset=windows-1251` with no in-document `<meta
   * charset>` renders as replacement characters if you assume UTF-8.
   */
  charset: string | null;
}

export interface RawResponse extends ContentType {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The URL actually served, after redirects — the base for relative og:image. */
  finalUrl: URL;
  stream: IncomingMessage;
}

/**
 * A `Range` we're willing to forward.
 *
 * The value comes from a browser, which means it comes from anyone who can reach the proxy
 * route. Unvalidated, a CR or LF in it makes node throw `ERR_INVALID_CHAR` out of the promise
 * executor below — node blocks the header injection, so nothing is smuggled, but the caller
 * gets a raw `TypeError` where this module promises to fail closed with an `UnsafeUrlError`.
 */
const RANGE_RE = /^bytes=\d*-\d*(?:,\s*\d*-\d*)*$/;

/** Split `text/html; charset=utf-8` into the parts callers actually use. */
function parseContentType(raw: string): ContentType {
  return {
    contentType: raw.split(';')[0].trim().toLowerCase(),
    charset: /;\s*charset\s*=\s*"?([\w-]+)"?/i.exec(raw)?.[1]?.toLowerCase() ?? null,
  };
}

/**
 * One hop, no redirect following, no body read. The caller decides whether to
 * buffer it (scraping) or pipe it (the byte proxy).
 */
function requestOnce(url: URL, opts: FetchOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    /** Whether the response headers have arrived, which is what the timeouts above pivot on. */
    let headersSeen = false;
    // Already given up before we dialled — don't open a socket to close it a tick later.
    if (opts.signal?.aborted) {
      return reject(new UnsafeUrlError('caller abandoned the request'));
    }
    if (opts.range !== undefined && !RANGE_RE.test(opts.range)) {
      return reject(new UnsafeUrlError(`refusing to forward a malformed Range: ${opts.range}`));
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: pinnedLookup,
        agent: mod === https ? httpsAgent : httpAgent,
        timeout: IDLE_TIMEOUT_MS,
        headers: {
          'User-Agent': userAgent(),
          Accept: opts.accept || 'text/html,application/xhtml+xml,*/*;q=0.8',
          // No Accept-Encoding on purpose. A byte cap counts *compressed* bytes,
          // so accepting gzip would let a small response decompress into
          // something enormous — a zip bomb aimed straight at the scrape buffer.
          // Identity costs bandwidth and removes a whole class of surprise.
          'Accept-Encoding': 'identity',
          ...(opts.range ? { Range: opts.range } : {}),
          // No cookies, no auth, ever. Included explicitly so a future edit that
          // adds a header set has to walk past this note.
        },
      },
      (res) => {
        // ⚠ Checked HERE, not in `bufferStream`, because the other consumer of a RawResponse
        // pipes it. We asked for identity; an origin that gzips anyway hands back bytes we
        // can neither size nor pass on — relaying them to a browser under the origin's own
        // `Content-Type: image/png` is a corrupt image with no transport error to explain it.
        const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase();
        if (encoding !== 'identity') {
          res.destroy();
          return reject(new UnsafeUrlError(`unexpected content-encoding: ${encoding}`));
        }
        headersSeen = true;
        if (opts.streaming) {
          // The deadline has done its job — it bounded connect and headers. Holding it through
          // the body cuts every transfer that takes longer than 20 s, which for a media proxy
          // is most of them.
          clearTimeout(deadline);
          req.setTimeout(STREAM_IDLE_TIMEOUT_MS);
        }
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          ...parseContentType(String(res.headers['content-type'] || '')),
          finalUrl: url,
          stream: res,
        });
      },
    );
    // Cleared when the request is done either way, and unref'd so a pending fetch can never be
    // the reason the process stays up.
    const deadline = setTimeout(() => {
      req.destroy(new UnsafeUrlError(`hop took longer than ${HOP_DEADLINE_MS}ms`));
    }, HOP_DEADLINE_MS);
    deadline.unref();

    // The caller gave up: end the request rather than leaving it running for whatever bound it
    // would have hit on its own. Removed on `close` so a long-lived signal — one caller's
    // controller outliving one hop of a redirect walk — doesn't accumulate listeners.
    const onAbort = (): void => {
      req.destroy(new UnsafeUrlError('caller abandoned the request'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => {
      clearTimeout(deadline);
      opts.signal?.removeEventListener('abort', onAbort);
    });
    // ⚠ Only observable BEFORE the response headers arrive. After that this promise has already
    // resolved, so the reject is a no-op and the destroy surfaces to whoever holds the stream —
    // as an ordinary stream error, indistinguishable from a peer reset. `bufferStream` treats
    // both the same way: what arrived is a prefix, and it says so.
    req.on('timeout', () =>
      req.destroy(new UnsafeUrlError(headersSeen ? 'stalled mid-body' : 'timed out with no data')),
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Follow up to MAX_REDIRECTS hops, re-vetting the target of every single one.
 *
 * A redirect into internal space is the most common way this bug actually ships:
 * the entry URL passes review, and `https://harmless.example/go` 302s to
 * `http://169.254.169.254/latest/meta-data/`. Each `Location` goes back through
 * `normalizeUrl` and a fresh pinned lookup, so hop 3 is checked exactly as hard
 * as hop 0.
 */
export async function safeRequest(start: URL, opts: FetchOptions = {}): Promise<RawResponse> {
  // Hop 0 goes through the same check as every other hop. Callers do normalize before they get
  // here, but "the caller remembered" is not a guard, and for an entry URL it's the ONLY one:
  // node skips DNS for an address literal, so `pinnedLookup` never runs and nothing downstream
  // would ever look at `http://169.254.169.254/`.
  const entry = normalizeUrl(start.toString());
  if (!entry) throw new UnsafeUrlError('refusing to fetch a disallowed URL');
  let url = entry;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Checked per hop, not just once: a redirect walk is up to four requests, and a caller that
    // gave up during hop 1 must not have hops 2 and 3 dialled on its behalf.
    if (opts.signal?.aborted) throw new UnsafeUrlError('caller abandoned the request');
    const res = await requestOnce(url, opts);
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.location;
    if (!isRedirect) return res;

    // Destroyed, not drained. `resume()` reads the ENTIRE redirect body first — a hostile
    // origin can answer 302 with a gigabyte, per hop, and none of the byte caps apply to it.
    // Draining exists to let a socket be reused, and keep-alive is off on both agents, so
    // nothing here needs the socket back.
    res.stream.destroy();
    if (hop === MAX_REDIRECTS) throw new UnsafeUrlError('too many redirects');
    // ⚠ The resolve is inside the try, not just the normalize. `Location: http://[` throws
    // `ERR_INVALID_URL` while BUILDING normalizeUrl's argument, so its own try/catch never sees
    // it — and an attacker-controlled header escaping as a raw TypeError makes a caller that
    // sorts `UnsafeUrlError` from everything else file a bug report against us.
    let next: URL | null = null;
    try {
      next = normalizeUrl(new URL(String(res.headers.location), url).toString());
    } catch {
      next = null;
    }
    if (!next) throw new UnsafeUrlError('redirect to a disallowed target');
    url = next;
  }
  throw new UnsafeUrlError('too many redirects');
}

export interface BufferedResponse extends ContentType {
  status: number;
  finalUrl: URL;
  body: Buffer;
  /**
   * True when `body` is a PREFIX of what the origin was sending — the cap fired, the peer went
   * away mid-message, or a deadline cut it off.
   *
   * ⚠ Stopping at `</head>` is deliberately NOT truncation: we got the whole of what we asked
   * for. The distinction is the whole value of this flag — a caller deciding whether metadata
   * might be missing gets told the truth either way.
   */
  truncated: boolean;
}

export interface BufferOptions {
  maxBytes?: number;
  /**
   * Stop as soon as `</head>` has been seen.
   *
   * Everything we scrape lives in the head, so the rest of the document is bytes we pay for
   * and discard. This is what lets the cap be generous — a well-formed page costs its head
   * and not a byte more, whatever the ceiling is set to.
   */
  stopAtHeadEnd?: boolean;
}

/**
 * Buffer a response we've already opened, hard-capped.
 *
 * Separate from `safeRequest` so a caller that has to inspect the headers before deciding
 * what to do — which is every caller — doesn't have to throw the response away and issue a
 * second request for the body. Doing that doubled every page fetch, which is both wasteful
 * and twice the chance of tripping a rate limit on a host we want to stay welcome at.
 *
 * The cap is enforced on bytes actually received, and ONLY on those. `Content-Length` is
 * deliberately not consulted — see the ⚠ note in the body: rejecting early on an oversized
 * declared length broke every caller here, all of which want a PREFIX. A maintainer trusting
 * the sentence that used to be here would have believed in a guard that had been removed.
 */
/**
 * What `stopAtHeadEnd` looks for.
 *
 * ⚠ The trailing delimiter is load-bearing, not decoration. Matching `</head` as a bare
 * substring also matches `</header>`, which is in the markup of roughly every site on the web
 * — and since a match TRIMS rather than merely stops, a page that omits the optional `</head>`
 * tag had its document silently cut at the first `</header>`, reporting `truncated: false`
 * about metadata that had been thrown away.
 *
 * Known residual: a literal `</head>` inside a comment or a script string still matches, since
 * this is a byte scan and not a tokenizer. That costs a preview, never a wrong one, and the
 * fix is a parser rather than a longer regex.
 */
const HEAD_END = /<\/head[\s/>]/;
/** The longest partial match that can carry across a chunk boundary: `</head`. */
const HEAD_END_CARRY = 6;

export async function bufferStream(
  res: RawResponse,
  opts: BufferOptions = {},
): Promise<BufferedResponse> {
  const maxBytes = opts.maxBytes ?? MAX_SCRAPE_BYTES;

  // ⚠ `maxBytes` means "read at most this much", NOT "refuse anything bigger". Every caller
  // here wants a PREFIX: the scraper wants a document's head, `imageDimensions` wants an
  // image's first few hundred bytes. An earlier version threw on an oversized
  // `Content-Length` and it broke both — Wikipedia (a 572 KB article) got no preview at all,
  // and image dimensions silently failed for every image over 64 KB, which is most of them.
  //
  // The place a size limit genuinely belongs is the byte proxy, which is serving a whole file
  // to a browser and enforces its own ceiling.

  // We asked for identity; anything else means we can't reason about the byte count, so we
  // don't try. `requestOnce` refuses these too — this is the same rule applied to a response
  // that reached us some other way, since a RawResponse is just an object.
  const encoding = String(res.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity') {
    res.stream.destroy();
    throw new UnsafeUrlError(`unexpected content-encoding: ${encoding}`);
  }

  // ⚠ Attaching listeners to a stream that is already finished means NOTHING ever fires, and
  // this promise hangs forever with no error and no log — a leaked await, not a failure. That
  // is reachable exactly the way the docblock above invites: inspect the headers, await a cache
  // lookup, and come back to a response the peer reset while you were gone.
  if (res.stream.destroyed || res.stream.readableEnded) {
    throw new UnsafeUrlError('the response stream was already closed');
  }

  return await new Promise<BufferedResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    /** The `</head>` cut fired: we have everything we asked for and are done reading. */
    let settled = false;
    /** This promise has been resolved. Distinct from `settled` — see `finish`. */
    let finished = false;
    // Rolling state for the `</head>` scan — see the data handler.
    let tail: Buffer = Buffer.alloc(0);
    let scanned = 0;

    res.stream.on('data', (chunk: Buffer) => {
      // ⚠ `destroy()` is not instantaneous — anything already queued still arrives. Without
      // this, a chunk landing after the cut appends bytes AFTER the `</head>` we just trimmed
      // to, and a chunk landing after truncation pushes the body past `maxBytes`. Both
      // guarantees this function makes are only true if it stops listening once it's done.
      if (settled) return;

      // Trim to the cap but keep going into the scan below, rather than returning here. A
      // chunk can both cross the cap AND close the head, and bailing early called that
      // `truncated: true` — telling a caller its metadata might be incomplete about a head
      // that had arrived whole.
      let piece = chunk;
      if (total + chunk.length > maxBytes) {
        // Keep the prefix — a truncated head is often still enough to find og: tags in, and
        // a partial answer beats no answer.
        piece = chunk.subarray(0, maxBytes - total);
        truncated = true;
      }
      total += piece.length;
      chunks.push(piece);

      if (opts.stopAtHeadEnd) {
        // Search only the NEW bytes plus a small overlap, not the whole buffer. Concatenating
        // and latin1-decoding everything on every chunk is O(n²) — on exactly the documents the
        // 512 KB ceiling exists for (metadata buried behind hundreds of KB of script) that's
        // tens of MB of copying and a full decode per chunk.
        //
        // `tail` is the last HEAD_END_CARRY bytes of everything scanned so far — the most that
        // can carry over — so a `</head>` split across a boundary is found however small the
        // chunks are. ⚠ It is NOT "the previous chunk": with chunks shorter than the tag, one
        // chunk of context isn't enough to span it, and the offset arithmetic below silently
        // trims into the head when it assumes more overlap than it was given.
        const window = Buffer.concat([tail, piece]);
        const found = HEAD_END.exec(window.toString('latin1').toLowerCase());
        if (found) {
          settled = true;
          // The head arrived complete, whatever the cap did to the bytes after it.
          truncated = false;
          // TRIM to the tag rather than merely stopping: stopping bounds the read at whatever
          // chunk boundary we landed on, so the saving would depend on the socket's chunk size.
          // Cutting makes the guarantee real — the caller gets the head and nothing after it.
          const keep = scanned - tail.length + found.index;
          const whole = Buffer.concat(chunks);
          chunks.length = 0;
          chunks.push(whole.subarray(0, keep));
          res.stream.destroy();
          return finish();
        }
        tail = window.subarray(Math.max(0, window.length - HEAD_END_CARRY));
        scanned += piece.length;
      }

      if (truncated) res.stream.destroy();
    });

    // A peer reset, our own deadline, a `req.destroy()` — all arrive here or at 'close', and
    // all of them mean the same thing: what we have is a prefix. Throwing it away would be
    // the opposite of the policy applied at the cap, and it throws away real previews —
    // a complete `<head>` followed by a reset is every tag we needed.
    res.stream.on('error', (err) => {
      if (settled) return finish(); // the head was already complete and cut
      if (total === 0) return reject(err); // nothing arrived; there is no partial answer
      truncated = true;
      finish();
    });
    res.stream.on('close', () => {
      // `complete` is node's "the message framing said this was all of it". False means the
      // body was cut short — best-effort, since a response framed only by EOF can't be judged
      // by anyone, but it catches the Content-Length and chunked cases.
      if (!settled && res.stream.complete === false) truncated = true;
      finish();
    });
    res.stream.on('end', finish);

    /** Settle once. Three events can fire for one response and `done()` copies the body. */
    function finish(): void {
      if (finished) return;
      finished = true;
      resolve(done());
    }

    function done(): BufferedResponse {
      return {
        status: res.status,
        contentType: res.contentType,
        charset: res.charset,
        finalUrl: res.finalUrl,
        body: Buffer.concat(chunks),
        truncated,
      };
    }
  });
}

/** Open a URL and buffer it in one step, for callers with nothing to decide. */
export async function fetchBuffered(
  url: URL,
  opts: FetchOptions & BufferOptions = {},
): Promise<BufferedResponse> {
  const res = await safeRequest(url, opts);
  return await bufferStream(res, opts);
}
