// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import sharp from './sharp.js';

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30"/></svg>',
);

describe('the sharp loader block', () => {
  it('refuses SVG bytes before librsvg sees them, whatever type they were served as', async () => {
    // ⚠ The probe is validated first: unblocking makes the same bytes parse, so the refusal
    // below is the block and not a fixture librsvg could never read anyway.
    sharp.unblock({ operation: ['VipsForeignLoadSvg'] });
    try {
      const meta = await sharp(SVG).metadata();
      expect(meta.format).toBe('svg');
    } finally {
      sharp.block({ operation: ['VipsForeignLoadSvg'] });
    }
    // Asserts THAT it rejects, never with what wording — libvips' message is its own.
    await expect(sharp(SVG).metadata()).rejects.toBeInstanceOf(Error);
  });

  it('refuses TIFF', async () => {
    sharp.unblock({ operation: ['VipsForeignLoadTiff'] });
    let tiff: Buffer;
    try {
      tiff = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } })
        .tiff()
        .toBuffer();
      expect((await sharp(tiff).metadata()).format).toBe('tiff');
    } finally {
      sharp.block({ operation: ['VipsForeignLoadTiff'] });
    }
    await expect(sharp(tiff).metadata()).rejects.toBeInstanceOf(Error);
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
