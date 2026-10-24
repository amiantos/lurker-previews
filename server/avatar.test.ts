// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Avatars (lurker#1190): the crop and its bounds on bytes made here, then the endpoint over
// real sockets against a live origin, with only the address policy mocked as in
// server.test.ts. What the endpoint tests pin above all: it never answers 404, because the
// cell reads that as a decoder too old to have the endpoint.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';

vi.mock('./utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const { makeAvatar } = await import('./avatar.js');
const { createServer } = await import('./server.js');
const { resetCooldownsForTests } = await import('./utils/originCooldown.js');

const still = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .toBuffer();

// Frames stacked by pageHeight, each a different shade, so the encoder keeps them all.
async function animatedGif(width: number, height: number, pages = 3): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * pages * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = Math.floor(i / (width * height * 4)) * 90;
    raw[i + 3] = 255;
  }
  return sharp(raw, { raw: { width, height: height * pages, channels: 4, pageHeight: height } })
    .gif()
    .toBuffer();
}

const big = { maxInputPixels: 25_000_000, maxAnimatedPixels: 20_000_000, maxAnimatedBytes: 1e6 };

describe('makeAvatar', () => {
  it('crops a still to a 256 square WebP', async () => {
    const out = await makeAvatar(await still(2000, 3000));
    const meta = await sharp(out.webp).metadata();
    expect([meta.format, meta.width, meta.height, out.animated]).toEqual(['webp', 256, 256, false]);
  });

  it('never enlarges: a small image becomes the square of its short side', async () => {
    const meta = await sharp((await makeAvatar(await still(100, 60))).webp).metadata();
    expect([meta.width, meta.height]).toEqual([60, 60]);
  });

  it('keeps an animated GIF animated, every frame cropped', async () => {
    const out = await makeAvatar(await animatedGif(300, 200), big);
    const meta = await sharp(out.webp, { animated: true }).metadata();
    expect([meta.format, meta.pages, meta.width, meta.pageHeight]).toEqual(['webp', 3, 200, 200]);
    expect(out.animated).toBe(true);
  });

  it('sends the first frame of an animation whose frames decode past the budget', async () => {
    const gif = await animatedGif(40, 40, 4); // 6400 px over its frames
    const out = await makeAvatar(gif, { ...big, maxAnimatedPixels: 6399 });
    const meta = await sharp(out.webp, { animated: true }).metadata();
    expect([meta.pages ?? 1, meta.width, out.animated]).toEqual([1, 40, false]);
  });

  it('sends the first frame of an animation that resizes past the byte budget', async () => {
    const out = await makeAvatar(await animatedGif(40, 40), { ...big, maxAnimatedBytes: 10 });
    expect(out.animated).toBe(false);
    expect((await sharp(out.webp, { animated: true }).metadata()).pages ?? 1).toBe(1);
  });

  it('refuses a still that decodes past the pixel bound', async () => {
    await expect(
      makeAvatar(await still(100, 100), { ...big, maxInputPixels: 9999 }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('refuses bytes that are not an image', async () => {
    await expect(makeAvatar(Buffer.from('<html></html>'))).rejects.toMatchObject({ status: 415 });
  });
});

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
let handler: Handler;
let origin: http.Server;
let originBase: string;
let service: http.Server;
let serviceBase: string;

beforeAll(async () => {
  origin = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  originBase = `http://localhost:${(origin.address() as AddressInfo).port}`;
  service = createServer({ ready: true, reason: '' });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  serviceBase = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => service.close(() => resolve()));
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

afterEach(() => resetCooldownsForTests());

const ask = (url: string) =>
  fetch(`${serviceBase}/avatar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });

describe('POST /avatar', () => {
  it('answers the avatar as WebP, and says when it is animated', async () => {
    const gif = await animatedGif(300, 200);
    handler = (_req, res) => res.writeHead(200, { 'content-type': 'image/gif' }).end(gif);
    const res = await ask(`${originBase}/me.gif`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('x-lurker-avatar-animated')).toBe('1');
    const meta = await sharp(Buffer.from(await res.arrayBuffer()), { animated: true }).metadata();
    expect([meta.pages, meta.width]).toEqual([3, 200]);
  });

  it("forwards the origin's Cache-Control, for the cell's store decision", async () => {
    const jpeg = await still(64, 64);
    handler = (_req, res) =>
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }).end(jpeg);
    const res = await ask(`${originBase}/private.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is a 415 for a body that is not an image', async () => {
    handler = (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<p>hi</p>');
    expect((await ask(`${originBase}/page`)).status).toBe(415);
  });

  it('is a 502, never a 404, for an origin that has nothing there', async () => {
    handler = (_req, res) => res.writeHead(404).end();
    expect((await ask(`${originBase}/gone.png`)).status).toBe(502);
  });

  it('is a 413 for a body past the byte cap, declared or not', async () => {
    const over = Buffer.alloc(8 * 1024 * 1024 + 1);
    handler = (_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(over);
    expect((await ask(`${originBase}/declared.png`)).status).toBe(413);
    handler = (_req, res) => {
      // Chunked: no length to judge, so the cap falls on the bytes seen.
      res.writeHead(200, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
      res.write(over.subarray(0, 4 * 1024 * 1024));
      res.end(over.subarray(4 * 1024 * 1024));
    };
    expect((await ask(`${originBase}/chunked.png`)).status).toBe(413);
  });

  it('is a 503 with Retry-After when the origin says to back off', async () => {
    handler = (_req, res) => res.writeHead(429, { 'retry-after': '7' }).end();
    const res = await ask(`${originBase}/busy.png`);
    expect(res.status).toBe(503);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('is a 403 for a URL the guard refuses', async () => {
    expect((await ask('http://10.0.0.1/me.png')).status).toBe(403);
    expect((await ask('file:///etc/passwd')).status).toBe(403);
  });
});
