// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Posters against a real origin over real sockets, with fixtures ffmpeg makes on
// the spot. Skipped wholesale when ffmpeg is absent (a Mac without brew ffmpeg) —
// the Docker test stage always runs them, and the image is where posters ship.
//
// The two fixtures are THE two cases that matter, straight from the prototype's
// probe: a +faststart mp4 (index up front — head fetch only) and a default-mux
// mp4 (index at the END, like every phone clip — head AND tail). The atom walk
// that tells them apart is itself asserted, so a fixture regression can't
// silently turn the tail test into a second copy of the head one.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('./utils/ipGuard.js', () => ({
  isBlockedIpLiteral: (host: string) => host.replace(/^\[|\]$/g, '') !== '127.0.0.1',
  isBlockedIpv4: (ip: string) => ip !== '127.0.0.1',
}));

const { posterForUrl, hasMoovInHead } = await import('./poster.js');
const { resolveUrl } = await import('./resolve.js');

const ffmpegHere = spawnSync('ffmpeg', ['-version']).status === 0;

/** Make a 1-second test video. `faststart` decides where the moov index lands. */
function makeVideo(file: string, faststart: boolean): void {
  const args = [
    '-nostdin',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=320x240:rate=10',
    ...(faststart ? ['-movflags', '+faststart'] : []),
    '-y',
    file,
  ];
  const out = spawnSync('ffmpeg', args);
  if (out.status !== 0) throw new Error(`fixture encode failed: ${out.stderr}`);
}

describe.skipIf(!ffmpegHere)('posters from a live origin', () => {
  let dir: string;
  let fastMp4: Buffer;
  let tailMp4: Buffer;
  let server: http.Server;
  let base: string;
  /** What the origin serves this test: the bytes, and whether Range is honoured. */
  let body: Buffer;
  let ranged = true;
  let asks: Array<string | undefined> = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'poster-fixtures-'));
    makeVideo(path.join(dir, 'fast.mp4'), true);
    makeVideo(path.join(dir, 'tail.mp4'), false);
    fastMp4 = await readFile(path.join(dir, 'fast.mp4'));
    tailMp4 = await readFile(path.join(dir, 'tail.mp4'));

    server = http.createServer((req, res) => {
      asks.push(req.headers.range);
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
      if (ranged && range) {
        const from = Number(range[1]);
        const to = Math.min(Number(range[2]), body.length - 1);
        const slice = body.subarray(from, to + 1);
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-length': String(slice.length),
          'content-range': `bytes ${from}-${to}/${body.length}`,
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  function serve(bytes: Buffer, withRanges: boolean) {
    body = bytes;
    ranged = withRanges;
    asks = [];
  }

  function poster(opts?: { headBytes?: number; tailBytes?: number }) {
    return posterForUrl(new URL(`${base}/clip.mp4`), new AbortController().signal, opts);
  }

  /** Where the top-level `moov` atom starts, found by walking atoms — not by a byte
   *  search, which `mdat`'s pixels could satisfy by accident. */
  function moovOffset(buf: Buffer): number {
    let off = 0;
    while (off + 8 <= buf.length) {
      const size = buf.readUInt32BE(off);
      if (buf.subarray(off + 4, off + 8).toString('latin1') === 'moov') return off;
      if (size < 8) throw new Error('unexpected atom while walking fixture');
      off += size;
    }
    throw new Error('fixture has no top-level moov');
  }

  /** A head cap that provably excludes the tail fixture's index while holding the whole
   *  first frame: everything up to just before `moov`. Derived, never guessed — fixture
   *  sizes move with the ffmpeg that encodes them. */
  function headBytesExcludingMoov(): number {
    const cut = moovOffset(tailMp4) - 256;
    expect(cut).toBeGreaterThan(1024); // the fixture must be big enough to mean anything
    return cut;
  }

  it('the fixtures disagree about where the index lives — the premise of everything below', () => {
    // ⚠ Without this, an ffmpeg that starts writing faststart by default would quietly turn
    // the tail-fetch test into a second head-only test, and the `.mov` path would be pinned
    // by nothing.
    //
    // ⚠ Judged on a HEAD-SIZED SLICE, the way the shipping code only ever sees it. On the
    // whole file the walk happily steps over `mdat` and finds the trailing `moov` — true,
    // and exactly not the question, which is "is the index in the bytes a head fetch got".
    const head = headBytesExcludingMoov();
    expect(hasMoovInHead(fastMp4.subarray(0, Math.min(head, fastMp4.length)))).toBe(true);
    expect(hasMoovInHead(tailMp4.subarray(0, head))).toBe(false);
    expect(moovOffset(tailMp4)).toBeGreaterThan(moovOffset(fastMp4));
  });

  it('faststart: one ranged request, a real frame, never upscaled', async () => {
    serve(fastMp4, true);
    const out = await poster({ headBytes: 64 * 1024 });
    expect(out).not.toBeNull();
    // JPEG magic — the bytes are a picture, not an error dressed as one.
    expect(out!.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    // 320 wide stays 320 wide: POSTER_MAX_EDGE clamps, it never inflates.
    expect(out!.width).toBe(320);
    expect(out!.height).toBe(240);
    // The index was up front, so the tail request never happened.
    expect(asks).toEqual(['bytes=0-65535']);
  });

  it('moov at the end: head plus tail, offsets preserved through the sparse file', async () => {
    // ⚠ THE phone-clip case. The head cap is derived to fall just short of the index, so
    // the first fetch genuinely lacks it — exactly the shape of hlbiwvr-0H4q.mov from the
    // outage postmortem — and the tail is sized to hold all of `moov` plus slack.
    const headBytes = headBytesExcludingMoov();
    const tailBytes = tailMp4.length - moovOffset(tailMp4) + 512;
    serve(tailMp4, true);
    const out = await poster({ headBytes, tailBytes });
    expect(out).not.toBeNull();
    expect(out!.width).toBe(320);
    expect(asks.length).toBe(2);
    expect(asks[0]).toBe(`bytes=0-${headBytes - 1}`);
    expect(asks[1]).toMatch(/^bytes=\d+-\d+$/);
  });

  it('an origin that ignores Range still yields a poster from a bounded read', async () => {
    serve(fastMp4, false);
    const out = await poster();
    expect(out).not.toBeNull();
    // One request, answered 200 with the whole (small) file; the head cap is what bounds
    // this same path when the file is not small.
    expect(asks.length).toBe(1);
  });

  it('answers null for bytes that are not media, rather than failing anything', async () => {
    serve(Buffer.from('<html>this is no video</html>'), true);
    expect(await poster()).toBeNull();
  });

  it('rides /resolve as wantPoster, and only when asked', async () => {
    serve(fastMp4, true);
    const signal = new AbortController().signal;

    const without = await resolveUrl(`${base}/clip.mp4`, signal);
    expect(without.verdict).toBe('ok');
    if (without.verdict !== 'ok') return;
    expect(without.meta.kind).toBe('video');
    expect(without.poster).toBeUndefined();

    const withPoster = await resolveUrl(`${base}/clip.mp4`, signal, { wantPoster: true });
    expect(withPoster.verdict).toBe('ok');
    if (withPoster.verdict !== 'ok') return;
    expect(withPoster.poster).toBeDefined();
    expect(withPoster.poster!.width).toBe(320);
    // The card's own fields are untouched by the poster riding along.
    expect(withPoster.meta.kind).toBe('video');
    expect(withPoster.meta.mime).toBe('video/mp4');
  });
});

describe('hasMoovInHead on hand-built atoms', () => {
  // These run everywhere, ffmpeg or not: the walk is pure buffer arithmetic.
  function atom(type: string, payload = 0): Buffer {
    const b = Buffer.alloc(8 + payload);
    b.writeUInt32BE(8 + payload, 0);
    b.write(type, 4, 'latin1');
    return b;
  }

  it('finds moov behind other atoms and stops at nonsense sizes', () => {
    expect(hasMoovInHead(Buffer.concat([atom('ftyp', 16), atom('moov', 64)]))).toBe(true);
    expect(hasMoovInHead(Buffer.concat([atom('ftyp', 16), atom('mdat', 64)]))).toBe(false);
    // size 0 = "to end of file": whatever follows is not cheaply reachable.
    const zero = atom('mdat');
    zero.writeUInt32BE(0, 0);
    expect(hasMoovInHead(Buffer.concat([zero, atom('moov')]))).toBe(false);
    // size < 8 is corrupt; refusing to walk it is the safe answer.
    const tiny = atom('mdat');
    tiny.writeUInt32BE(4, 0);
    expect(hasMoovInHead(Buffer.concat([tiny, atom('moov')]))).toBe(false);
    expect(hasMoovInHead(Buffer.alloc(0))).toBe(false);
  });
});

/**
 * ⚠⚠ lurker-previews#1. An HDR frame decoded as though it were bt709 is read off the wrong
 * curve entirely — PQ and HLG both encode luminance quite differently from a gamma ramp —
 * so the poster lands at the wrong brightness. These fixtures are the same PIXELS tagged
 * three ways, which is what makes the assertion sharp: without tone mapping all three
 * posters are byte-identical, because to ffmpeg they are the same picture.
 */
describe.skipIf(!ffmpegHere)('HDR posters', () => {
  let dir: string;

  /** A ramp encoded with `transfer` as its declared characteristic. */
  function makeRamp(file: string, transfer: string, primaries: string, matrix: string): void {
    const out = spawnSync('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'gradients=s=320x180:c0=black:c1=white:x0=0:y0=0:x1=320:y1=0:d=1:r=10',
      '-frames:v',
      '10',
      // ⚠ 8-bit, though real HDR is 10. These fixtures are only ever read for their
      // color_transfer TAG, and forcing 10-bit with no explicit codec asks the default
      // Matroska encoder for high10 — which a smaller ffmpeg build can lack while decoding
      // HDR at runtime perfectly well, failing the suite for a reason it does not test.
      // (Copilot.)
      '-pix_fmt',
      'yuv420p',
      '-color_trc',
      transfer,
      '-color_primaries',
      primaries,
      '-colorspace',
      matrix,
      '-color_range',
      'tv',
      '-y',
      file,
    ]);
    if (out.status !== 0) throw new Error(`fixture encode failed: ${out.stderr}`);
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'poster-hdr-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('tone-maps PQ and HLG, and leaves SDR exactly as it was', async () => {
    const { posterFilter } = await import('./poster.js');

    const pq = path.join(dir, 'pq.mkv');
    makeRamp(pq, 'smpte2084', 'bt2020', 'bt2020nc');
    expect(await posterFilter(pq)).toContain('tonemap=');

    // ⚠ HLG specifically, because it is what phone cameras record HDR in — and the
    // direction that reads as "too bright", which is how the issue was reported.
    const hlg = path.join(dir, 'hlg.mkv');
    makeRamp(hlg, 'arib-std-b67', 'bt709', 'bt709');
    expect(await posterFilter(hlg)).toContain('tonemap=');

    // ⚠⚠ The half that stops this being a regression for everyone else. An SDR clip must
    // reach ffmpeg with the SAME chain it did before — byte-identical, not merely
    // tone-map-free — because running a curve over a picture that is already right can
    // only make it wrong, and SDR is almost everything.
    const sdr = path.join(dir, 'sdr.mkv');
    makeRamp(sdr, 'bt709', 'bt709', 'bt709');
    expect(await posterFilter(sdr)).toBe(`scale='min(640,iw)':-2`);
  });

  it('still produces a usable poster for an HDR clip', async () => {
    // ⚠ Not a brightness assertion — see `posterFilter`'s note for why one is not available
    // here. This is the other half: the tone-mapped chain must actually DECODE in the image
    // ffmpeg ships in. A chain that is correct and unrunnable is a poster nobody gets, and
    // the fallback that covers it is only reachable if this can fail.
    const { posterForUrl } = await import('./poster.js');
    makeRamp(path.join(dir, 'live.mkv'), 'arib-std-b67', 'bt2020', 'bt2020nc');
    const body = await readFile(path.join(dir, 'live.mkv'));

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/x-matroska', 'content-length': body.length });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const poster = await posterForUrl(
        new URL(`http://localhost:${port}/live.mkv`),
        AbortSignal.timeout(30_000),
      );
      expect(poster).not.toBeNull();
      expect(poster!.jpeg.length).toBeGreaterThan(0);
      expect(poster!.width).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe.skipIf(!ffmpegHere)('the tone-map fallback', () => {
  it('falls back to the plain chain when the tone-mapped one will not run', async () => {
    // ⚠⚠ The branch that exists for builds without libzimg, which is not a build this suite
    // can obtain — so the unrunnable chain is supplied directly instead. A filter ffmpeg
    // refuses stands in for a filter it does not have: both make the command exit without
    // writing a frame, which is the only property the fallback keys on.
    const { decodeWithFallbackForTests } = await import('./poster.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'poster-fb-'));
    try {
      const file = path.join(dir, 'clip.mp4');
      makeVideo(file, true);

      // Sanity first: the plain chain really does decode this file, so a null below is the
      // fallback failing rather than the fixture being undecodable.
      expect(
        await decodeWithFallbackForTests(file, false, `scale='min(640,iw)':-2`),
      ).not.toBeNull();

      const frame = await decodeWithFallbackForTests(
        file,
        false,
        `definitely_not_a_filter=1,scale='min(640,iw)':-2`,
      );
      expect(frame).not.toBeNull();
      expect(frame!.jpeg.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
