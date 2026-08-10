// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The whole service over real sockets: a live decoder talking to a live origin,
// with only the address POLICY mocked (allow 127.0.0.1, refuse everything else —
// the policy itself is tested in ./utils/ipGuard.test.ts). What these pin above
// all is the STATUS MAPPING: the contract's whole value is that 502 and 503
// never collapse, and that 503 always says when to come back.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';

vi.mock('./utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const { createServer } = await import('./server.js');
const { resetCooldownsForTests } = await import('./utils/originCooldown.js');

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let handler: Handler;
let origin: http.Server;
let originBase: string;
let service: http.Server;
let serviceBase: string;
const state = { ready: true, reason: '' };

beforeAll(async () => {
  origin = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  originBase = `http://localhost:${(origin.address() as AddressInfo).port}`;

  service = createServer(state);
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  serviceBase = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => service.close(() => resolve()));
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

afterEach(() => {
  state.ready = true;
  state.reason = '';
  resetCooldownsForTests();
});

function post(path: string, body: unknown) {
  return fetch(`${serviceBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/health and the not-ready latch', () => {
  it('answers ok when the self-test has passed', async () => {
    const res = await fetch(`${serviceBase}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('refuses to SERVE while containment is unproven, not just to report it', async () => {
    // ⚠ The property is that no byte of input is touched: /resolve and /fetch answer 503
    // before parsing anything, and the 503 carries Retry-After like every other 503 in the
    // contract, so the cell files it as transient and self-heals when the operator fixes
    // the rules.
    state.ready = false;
    state.reason = 'egress containment FAILED\n';

    const health = await fetch(`${serviceBase}/health`);
    expect(health.status).toBe(503);
    expect(await health.text()).toContain('FAILED');

    handler = (_req, _res) => {
      throw new Error('the origin must never be dialled while not ready');
    };
    const resolve = await post('/resolve', { url: `${originBase}/page` });
    expect(resolve.status).toBe(503);
    expect(resolve.headers.get('retry-after')).toBeTruthy();
  });
});

describe('POST /resolve status mapping', () => {
  it('answers 200 with clamped metadata for a page worth a card', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head>
        <meta property="og:title" content="A Headline">
        <meta property="og:image" content="/card.png">
      </head></html>`);
    };
    const res = await post('/resolve', { url: `${originBase}/article` });
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.kind).toBe('page');
    expect(meta.title).toBe('A Headline');
    expect(meta.imageUrl).toBe(`${originBase}/card.png`);
  });

  it('answers 204 when a page has nothing worth showing', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head></head><body>plain</body></html>');
    };
    expect((await post('/resolve', { url: `${originBase}/blank` })).status).toBe(204);
  });

  it('answers 403 with the guard’s reason for a refused URL', async () => {
    const res = await post('/resolve', { url: 'http://10.6.6.6/blocked' });
    expect(res.status).toBe(403);
    // The reason feeds the cell's warn line — "misconfigured link or somebody probing".
    expect(((await res.json()) as { reason?: string }).reason).toBeTruthy();
  });

  it('answers 502 for an origin that gives nothing usable', async () => {
    handler = (_req, res) => {
      res.socket?.destroy();
    };
    expect((await post('/resolve', { url: `${originBase}/reset` })).status).toBe(502);
  });

  it('answers 503 + Retry-After for an origin that asked us to back off', async () => {
    // ⚠⚠ THE transient split, across the process boundary. 502 here would be cached by the
    // cell as a dead link for an hour on the strength of one rate-limited minute.
    handler = (_req, res) => {
      res.writeHead(429, { 'retry-after': '120' });
      res.end();
    };
    const res = await post('/resolve', { url: `${originBase}/limited` });
    expect(res.status).toBe(503);
    const retry = Number(res.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(120);
  });
});

describe('POST /fetch', () => {
  it('streams image bytes with the origin’s type and length', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) });
      res.end(png);
    };
    const res = await post('/fetch', { url: `${originBase}/a.png` });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe(String(png.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
  });

  it('refuses a non-image content type with 404 — a fact about the URL, not a moment', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not an image</html>');
    };
    expect((await post('/fetch', { url: `${originBase}/page` })).status).toBe(404);
  });

  it('refuses SVG through the shared allowlist', async () => {
    // ⚠ The one place `image/svg+xml` is refused on the byte path — a scripting format
    // wearing a picture's clothes must not come back under anyone's trusted origin.
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
    };
    expect((await post('/fetch', { url: `${originBase}/logo.svg` })).status).toBe(404);
  });

  it('answers 413 for a declared length past the cap, without reading the body', async () => {
    handler = (_req, res) => {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(64 * 1024 * 1024),
      });
      // Deliberately never writes the body: the refusal must come from the headers —
      // which `writeHead` alone does not put on the wire; node holds them for the first
      // body byte that is never coming.
      res.flushHeaders();
    };
    expect((await post('/fetch', { url: `${originBase}/huge.png` })).status).toBe(413);
  });

  it('answers 503 + Retry-After for a rate-limited image host, and remembers it', async () => {
    let asks = 0;
    handler = (_req, res) => {
      asks++;
      res.writeHead(429, { 'retry-after': '90' });
      res.end();
    };
    const first = await post('/fetch', { url: `${originBase}/limited.png` });
    expect(first.status).toBe(503);
    expect(Number(first.headers.get('retry-after'))).toBeGreaterThan(0);

    // ⚠ The cooldown's whole point: the second ask never leaves this process, so the origin's
    // budget can recover. Measured on GitHub's og:image host, which is where this rule came from.
    const second = await post('/fetch', { url: `${originBase}/other.png` });
    expect(second.status).toBe(503);
    expect(asks).toBe(1);
  });

  it('answers 403 for a URL the guard refuses', async () => {
    expect((await post('/fetch', { url: 'http://10.9.9.9/x.png' })).status).toBe(403);
  });
});

describe('request plumbing', () => {
  it('rejects a non-JSON body with 400 rather than a stack trace', async () => {
    const res = await fetch(`${serviceBase}/resolve`, { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
  });

  it('rejects a body without a url', async () => {
    expect((await post('/resolve', { nope: true })).status).toBe(400);
  });

  it('404s everything that is not the three endpoints', async () => {
    expect((await fetch(`${serviceBase}/anything`)).status).toBe(404);
    expect((await fetch(`${serviceBase}/resolve`)).status).toBe(404); // GET, not POST
  });
});
