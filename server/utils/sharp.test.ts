// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import sharp, { BLOCKED_LOADERS } from './sharp.js';

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30"/></svg>',
);

/**
 * ⚠ ORDER MATTERS. The refusal is asserted FIRST, against the state `./sharp.js` left at import
 * — that is the startup block, the thing under test. Only then is the fixture validated by
 * unblocking the loader and parsing the same bytes, so the refusal is known to be the block
 * and not a fixture libvips could never read. A test that installed the block itself before
 * asserting passed with the startup call deleted (Codex).
 */
async function assertBlockedLoader(loader: string, bytes: Buffer, format: string): Promise<void> {
  expect(BLOCKED_LOADERS).toContain(loader);
  // Asserts THAT it rejects, never with what wording — libvips' message is its own.
  await expect(sharp(bytes).metadata()).rejects.toBeInstanceOf(Error);
  sharp.unblock({ operation: [loader] });
  try {
    expect((await sharp(bytes).metadata()).format).toBe(format);
  } finally {
    sharp.block({ operation: [loader] });
  }
  await expect(sharp(bytes).metadata()).rejects.toBeInstanceOf(Error);
}

describe('the sharp loader block', () => {
  it('refuses SVG bytes before librsvg sees them, whatever type they were served as', async () => {
    await expect(assertBlockedLoader('VipsForeignLoadSvg', SVG, 'svg')).resolves.toBeUndefined();
  });

  it('refuses TIFF', async () => {
    // The fixture is encoded with the loader still blocked: SAVING is a different operation.
    const tiff = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } })
      .tiff()
      .toBuffer();
    await expect(assertBlockedLoader('VipsForeignLoadTiff', tiff, 'tiff')).resolves.toBeUndefined();
  });

  it('still reads every format the web serves', async () => {
    for (const encode of ['jpeg', 'png', 'webp', 'gif', 'avif'] as const) {
      const image = sharp({ create: { width: 8, height: 8, channels: 3, background: '#0f0' } });
      const bytes = await image[encode]().toBuffer();
      const meta = await sharp(bytes).metadata();
      expect(meta.width).toBe(8);
    }
  });
});
