// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The HTTP surface. Three endpoints, `node:http`, no framework — this service's
// entire justification is a small attack surface, and a router dependency is
// surface. The caller is the cell, over a private bridge; there is no auth
// because there are no credentials here to protect and nothing reaches this
// process except through that network. (Adding auth would mean adding a secret,
// and a box built to be compromised is the last place to park one.)
//
//   GET  /health          200 once the self-test passed; 503 otherwise
//   POST /resolve         { url }          → verdict, per the contract
//   POST /fetch           { url, range? }  → image bytes, streamed
//
// Status mapping is the contract's whole value — see resolve.ts's header and
// lurker-dev/LINK_PREVIEWS_ISOLATION.md. ⚠⚠ 503 ALWAYS carries Retry-After, and
// 502/503 never collapse into each other.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveUrl } from './resolve.js';
import { fetchImage } from './fetchImage.js';
import { SlotPool } from './utils/slotPool.js';
import { withDeadline, DeadlineExceeded } from './utils/withDeadline.js';

/**
 * Resolves in flight, mirroring the bound the cell keeps on its side of the seam.
 *
 * The cell's own pool guarantees it never has more than its batch size outstanding
 * against us, so under one cell this pool never queues — it exists for the day a
 * second caller shows up, and as this process's own bound on outstanding
 * uncancellable `getaddrinfo` slots (see fetchImage.ts's pool note; the resolve
 * walk can hold several lookups per URL across its redirect hops).
 */
const resolvePool = new SlotPool({ size: 20, maxQueued: 200, waitMs: 10_000 });

/**
 * Ceiling on one URL's whole resolution, once it holds a slot.
 *
 * ⚠ Without this the per-hop bounds multiply out to something absurd: one URL can chain three
 * separate fetch walks — the provider oEmbed call, the page fetch it falls through to, and the
 * oEmbed endpoint discovered in that page — each of MAX_REDIRECTS + 1 hops at HOP_DEADLINE_MS,
 * so roughly four minutes of holding a slot while every other caller's `acquire` times out.
 *
 * ⚠ The deadline ABORTS the work, it doesn't merely stop waiting for it. Racing a promise
 * abandons it, and abandoning is not ending: the fetch keeps its socket for its own hop budget
 * while the `finally` hands its pool slot to somebody else — so the pool undercounts its own
 * work, and under a run of slow origins more than its size are live at once, without bound.
 * A cap that a timeout quietly lifts is not a cap.
 */
const RESOLVE_DEADLINE_MS = 30_000;

/** Request bodies are one URL and change — 64 KB is generous by three orders of magnitude,
 *  and reading an unbounded body into memory is this module's one buffering path. */
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        // ⚠ Destroy rather than merely stop reading: a caller that keeps sending would
        // otherwise hold this socket, and the point of the limit is to bound what one
        // request costs.
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    ...headers,
  });
  res.end(payload);
}

export interface ServerState {
  /** False until the self-test passes; while false, everything answers 503. */
  ready: boolean;
  /** Why not, for /health's body and the operator's curl. */
  reason: string;
}

async function handleResolve(res: ServerResponse, rawUrl: string): Promise<void> {
  if (!(await resolvePool.acquire())) {
    // Saturated is a fact about this instant — the transient TTL's whole reason.
    res.writeHead(503, { 'retry-after': '5' }).end();
    return;
  }
  const controller = new AbortController();
  try {
    const out = await withDeadline(
      resolveUrl(rawUrl, controller.signal),
      RESOLVE_DEADLINE_MS,
      'resolve',
    );
    switch (out.verdict) {
      case 'ok':
        json(res, 200, out.meta);
        return;
      case 'none':
        res.writeHead(204).end();
        return;
      case 'refused':
        // The reason is for the CELL's warn line — "misconfigured link or somebody
        // probing" — which stayed exactly as informative as it was in-process.
        json(res, 403, { reason: out.reason });
        return;
      case 'dead':
        res.writeHead(502).end();
        return;
      case 'backoff':
        res.writeHead(503, { 'retry-after': String(out.retryAfterS) }).end();
        return;
    }
  } catch (err) {
    if (err instanceof DeadlineExceeded) {
      // ⚠ Running out of time is NOT a verdict about the URL — the origin was slow, which is
      // a fact about a moment. 503 so the cell gives it the transient TTL and no row; 502
      // here would blank a perfectly good link for an hour on the strength of one bad
      // afternoon. The abort is what makes the slot release below honest — see the pool note.
      controller.abort();
      res.writeHead(503, { 'retry-after': '30' }).end();
      return;
    }
    // resolveUrl promises not to throw; anything here is our own defect. 500 is honest and
    // the cell treats it transiently.
    console.error(`[previews] resolve crashed: ${String(err)}`);
    if (!res.headersSent) res.writeHead(500).end();
  } finally {
    resolvePool.release();
  }
}

export function createHandler(state: ServerState) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(state.ready ? 200 : 503, { 'content-type': 'text/plain' });
        res.end(state.ready ? 'ok' : state.reason);
        return;
      }
      if (!state.ready) {
        // ⚠ Refusing to SERVE, not just to report: a decoder whose containment is unproven
        // must not touch a byte of anyone's input. The cell reads any 503 as transient.
        res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '60' });
        res.end(state.reason);
        return;
      }
      if (req.method !== 'POST' || (req.url !== '/resolve' && req.url !== '/fetch')) {
        res.writeHead(404).end();
        return;
      }

      const body = await readBody(req, MAX_BODY_BYTES);
      if (body === null) {
        res.writeHead(413).end();
        return;
      }
      let parsed: { url?: unknown; range?: unknown };
      try {
        parsed = JSON.parse(body.toString('utf8')) as typeof parsed;
      } catch {
        json(res, 400, { error: 'body must be JSON' });
        return;
      }
      if (typeof parsed.url !== 'string' || !parsed.url) {
        json(res, 400, { error: 'url must be a string' });
        return;
      }

      if (req.url === '/resolve') {
        await handleResolve(res, parsed.url);
        return;
      }
      // /fetch. The range is passed through untrusted — linkFetch's RANGE_RE refuses a
      // malformed one with an UnsafeUrlError, which maps to 403 like every other refusal.
      const range = typeof parsed.range === 'string' && parsed.range ? parsed.range : undefined;
      await fetchImage(res, parsed.url, range);
    })().catch((err) => {
      console.error(`[previews] handler crashed: ${String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  };
}

export function createServer(state: ServerState): http.Server {
  return http.createServer(createHandler(state));
}
