// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// ⚠⚠ SHARP IS THE ORACLE, and that is the whole design of this suite. A hand-written header
// reader is exactly the shape of code this feature has been bitten by before — the entity decoder
// in linkMeta shipped with a hex/decimal alternation bug that eleven review agents missed and
// Copilot caught. So nothing here asserts a dimension I worked out by hand: every case encodes a
// real image at a known size, asks sharp what the FULL buffer is, and requires this module to
// agree from a truncated prefix. If the two ever disagree, the test says so without anyone having
// to have anticipated the case.

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { dimensionsFromHeader } from './imageHeader.js';

/** Random pixels, so the encoders cannot compress the fixture down under the truncation cap. */
function noise(width: number, height: number, channels: 3 | 4): Buffer {
  return crypto.randomBytes(width * height * channels);
}

function raw(width: number, height: number, channels: 3 | 4) {
  return sharp(noise(width, height, channels), { raw: { width, height, channels } });
}

// Sizes chosen for the edges of the field widths this module reads: 1 is the minimum, 16383 is
// the maximum a WebP 14-bit dimension can express, and the middle sizes are ordinary.
//
// ⚠ Deliberately kept small in PIXEL COUNT. An earlier version used 2000x1500, and quantising 3M
// random pixels to a GIF palette took long enough to blow vitest's 5s default — but only when the
// suite shared a machine with another, so it passed alone and failed in the full run. Every size
// here still exceeds the 64 KB truncation cap once encoded from noise, which is the only property
// the fixtures need.
//
// ⚠⚠ Shrinking them was not enough, and could not have been. It lowered the PROBABILITY of that
// failure without touching its cause, so the same test timed out again in CI on an unrelated PR
// — `gif 1234x567`, one word of client CSS away from the previous green run. Measured on an idle
// machine faster than any CI runner: that case alone costs ~1.6s of the 5s budget, and vitest
// runs 244 test files across parallel workers on 2-4 vCPUs, so contention of 3x is ordinary
// rather than exceptional. A margin that small is not a margin.
//
// The timeout below is the actual fix: this suite asserts CORRECTNESS and makes no claim about
// speed, so a generous bound costs nothing when it passes and removes a load-dependent false
// failure that no one can reproduce on demand. Shrinking the fixtures further is not available
// — every size has to out-run the 64 KB cap to be a fixture at all.
const SIZES: Array<[number, number]> = [
  [1, 1],
  [16383, 3],
  [3, 16383],
  [640, 480],
  [1234, 567],
  [600, 400],
];

describe('dimensionsFromHeader agrees with sharp, from a truncated buffer', () => {
  const encoders: Record<string, (w: number, h: number) => Promise<Buffer>> = {
    'webp lossy': (w, h) => raw(w, h, 3).webp({ quality: 90 }).toBuffer(),
    'webp lossless': (w, h) => raw(w, h, 3).webp({ lossless: true }).toBuffer(),
    'webp alpha (VP8X)': (w, h) => raw(w, h, 4).webp().toBuffer(),
    gif: (w, h) => raw(w, h, 3).gif().toBuffer(),
  };

  for (const [label, encode] of Object.entries(encoders)) {
    for (const [w, h] of SIZES) {
      it(`${label} ${w}x${h}`, async () => {
        const full = await encode(w, h);
        const truth = await sharp(full).metadata();

        // The cap the resolver actually uses, plus a far tighter one — the header is tiny, so a
        // reader that needs 64 KB is reading more than it should.
        for (const cap of [64 * 1024, 512]) {
          expect(dimensionsFromHeader(full.subarray(0, cap))).toEqual({
            width: truth.width,
            height: truth.height,
          });
        }
        // ⚠ The third argument is the per-test timeout, and it is load insurance rather than an
        // admission that anything here is slow. See the note on SIZES above.
      }, 30_000);
    }
  }
});

describe('the case that motivated this', () => {
  it('reads a WebP that sharp itself refuses at the resolver cap', async () => {
    // ⚠ The bug in one test. libwebp validates the RIFF length against the bytes supplied and
    // rejects the file before decoding anything, so a WebP over 64 KB reached the client with no
    // dimensions while the same picture as a PNG did not. Both halves are asserted, because
    // "our reader works" is only interesting alongside "the thing it replaces does not".
    const full = await raw(600, 400, 3).webp().toBuffer();
    expect(full.length).toBeGreaterThan(64 * 1024);
    const head = full.subarray(0, 64 * 1024);

    // ⚠ Asserts only that it REJECTS. Matching the message text couples this to a libvips /
    // libwebp build — and the regex was only there because oxlint's `require-to-throw-message`
    // refuses a bare `toThrow()`. `toBeInstanceOf` satisfies both: no message, no lint rule.
    await expect(sharp(head).metadata()).rejects.toBeInstanceOf(Error);
    expect(dimensionsFromHeader(head)).toEqual({ width: 600, height: 400 });
  });

  it('reads a GIF that sharp refuses at the same cap', async () => {
    const full = await raw(600, 400, 3).gif().toBuffer();
    expect(full.length).toBeGreaterThan(64 * 1024);
    const head = full.subarray(0, 64 * 1024);

    // ⚠ Asserts only that it REJECTS. Matching the message text couples this to a libvips /
    // libwebp build — and the regex was only there because oxlint's `require-to-throw-message`
    // refuses a bare `toThrow()`. `toBeInstanceOf` satisfies both: no message, no lint rule.
    await expect(sharp(head).metadata()).rejects.toBeInstanceOf(Error);
    expect(dimensionsFromHeader(head)).toEqual({ width: 600, height: 400 });
  });
});

describe('refuses what it does not understand', () => {
  it('returns null for formats sharp already handles', async () => {
    // Not a fallback for everything — PNG, JPEG and AVIF all read fine truncated, so this module
    // must not shadow them with a second implementation that could disagree.
    for (const fmt of ['png', 'jpeg', 'avif'] as const) {
      const buf = await raw(300, 200, 3).toFormat(fmt).toBuffer();
      expect(dimensionsFromHeader(buf)).toBeNull();
    }
  });

  it('returns null rather than inventing a size for junk', () => {
    expect(dimensionsFromHeader(Buffer.alloc(0))).toBeNull();
    expect(dimensionsFromHeader(Buffer.from('not an image at all'))).toBeNull();
    // Long enough to index into, wrong everywhere it counts.
    expect(dimensionsFromHeader(Buffer.alloc(4096))).toBeNull();
  });

  it('refuses a RIFF/WEBP wrapper around an unknown chunk', () => {
    // A container we recognise carrying a chunk we do not is exactly where a lenient parser
    // starts reading two arbitrary integers out of whatever follows.
    const buf = Buffer.alloc(64);
    buf.write('RIFF', 0, 'latin1');
    buf.writeUInt32LE(56, 4);
    buf.write('WEBP', 8, 'latin1');
    buf.write('XXXX', 12, 'latin1');
    expect(dimensionsFromHeader(buf)).toBeNull();
  });

  it('refuses a VP8 chunk whose start code is wrong', () => {
    // ⚠ Without the start-code check, this returns the two 14-bit numbers that happen to sit at
    // those offsets — a confidently wrong box, which is worse than no box.
    const buf = Buffer.alloc(64);
    buf.write('RIFF', 0, 'latin1');
    buf.writeUInt32LE(56, 4);
    buf.write('WEBP', 8, 'latin1');
    buf.write('VP8 ', 12, 'latin1');
    buf.writeUInt16LE(1234, 26);
    buf.writeUInt16LE(567, 28);
    expect(dimensionsFromHeader(buf)).toBeNull();

    // ...and with the start code present, the same bytes ARE the size.
    buf[23] = 0x9d;
    buf[24] = 0x01;
    buf[25] = 0x2a;
    expect(dimensionsFromHeader(buf)).toEqual({ width: 1234, height: 567 });
  });

  it('reads only 14 bits of a VP8 dimension, not 16', () => {
    // ⚠ SYNTHETIC on purpose, and it is the one case sharp cannot act as oracle for: the top two
    // bits of each 16-bit field are the horizontal/vertical SCALE, not part of the size, and
    // sharp's encoder always writes them as zero — so every generated fixture agrees whether the
    // mask is there or not. Dropping the mask left the whole suite green while a real file
    // carrying a scale would have reported a wildly wrong box.
    const buf = Buffer.alloc(64);
    buf.write('RIFF', 0, 'latin1');
    buf.writeUInt32LE(56, 4);
    buf.write('WEBP', 8, 'latin1');
    buf.write('VP8 ', 12, 'latin1');
    buf[23] = 0x9d;
    buf[24] = 0x01;
    buf[25] = 0x2a;
    // 800 and 600 with both scale bits set (0b11 << 14 = 0xc000).
    buf.writeUInt16LE(800 | 0xc000, 26);
    buf.writeUInt16LE(600 | 0xc000, 28);
    expect(dimensionsFromHeader(buf)).toEqual({ width: 800, height: 600 });
  });

  it('refuses a GIF header claiming a zero dimension', () => {
    // A zero-sized box is worse than an absent one: the client reserves nothing while believing
    // it has measured.
    const buf = Buffer.alloc(32);
    buf.write('GIF89a', 0, 'latin1');
    buf.writeUInt16LE(0, 6);
    buf.writeUInt16LE(400, 8);
    expect(dimensionsFromHeader(buf)).toBeNull();
  });
});
