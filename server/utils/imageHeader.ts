// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Pixel dimensions read straight out of an image's first bytes.
//
// ⚠⚠ This exists because sharp cannot do it for every format from a TRUNCATED buffer, and the
// preview resolver deliberately only reads a header's worth (64 KB) rather than downloading whole
// images. Measured across formats at that cap:
//
//   png   -> ok        jpeg -> ok        avif -> ok
//   webp  -> THROWS    gif  -> THROWS    tiff -> THROWS
//
// The cause is not a truncated *header* — every one of these puts its dimensions in the first
// few dozen bytes. It is that the container declares a total length: libwebp validates the RIFF
// size against the bytes actually supplied and refuses the file outright, before decoding
// anything, and the GIF loader behaves the same way. No sharp option relaxes it (`failOn: 'none'`
// and `failOn: 'truncated'` both still throw), because the rejection happens above the decoder.
//
// The consequence was visible in QA: a WebP over 64 KB reached the client with no dimensions, so
// the client could not reserve an aspect ratio and fell back to a fixed placeholder box — while
// the same picture as a PNG rendered correctly. A *size*-specific bug that looked format-specific.
//
// GIF and WebP are handled here because both are ordinary things to paste into IRC and both have
// a fixed-offset header. TIFF is deliberately NOT: its dimensions live behind an IFD offset walk,
// it is rare as an inline image, and the fallback (no dimensions) is now merely a reserved box
// rather than a layout jump. A parser is a liability in proportion to what it must understand.

export interface PixelSize {
  width: number;
  height: number;
}

/**
 * WebP, from the RIFF container's first chunk.
 *
 * Three chunk types carry a size, and all three put it at a fixed offset:
 *
 *   VP8   lossy      — 14-bit width/height after the 3-byte start code
 *   VP8L  lossless   — 14-bit width-1/height-1 packed into one LE32
 *   VP8X  extended   — 24-bit canvas width-1/height-1 (alpha, animation, metadata)
 *
 * ⚠ VP8X is the CANVAS size, which is the right answer: for an animated or alpha WebP the first
 * frame can be smaller than the canvas it is composited onto, and the canvas is what occupies
 * space on screen.
 */
function webpSize(buf: Buffer): PixelSize | null {
  if (buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  switch (buf.toString('latin1', 12, 16)) {
    case 'VP8 ': {
      // The 3-byte start code is the only thing distinguishing a real key frame from noise at
      // this offset; without it a corrupt file yields two plausible-looking 14-bit numbers.
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    case 'VP8L': {
      if (buf[20] !== 0x2f) return null;
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X':
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    default:
      return null;
  }
}

/**
 * GIF, from the logical screen descriptor.
 *
 * ⚠ The LOGICAL SCREEN, not the first frame. A GIF's frames are composited onto that screen and
 * may each be smaller than it, so the screen is the box the image occupies — and it is what sharp
 * reports for an untruncated file, which the tests assert directly rather than assume.
 */
function gifSize(buf: Buffer): PixelSize | null {
  if (buf.length < 10) return null;
  const magic = buf.toString('latin1', 0, 6);
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/**
 * Dimensions from a header, or null if this module doesn't understand the format.
 *
 * A null answer is not an error — it means "ask something else", and the only caller falls back
 * to shipping no dimensions at all, which costs a reserved box rather than a wrong one. Anything
 * non-positive is refused rather than passed on: a zero-sized box is worse than an absent one,
 * because the client would reserve nothing and still believe it had measured.
 */
export function dimensionsFromHeader(buf: Buffer): PixelSize | null {
  const size = webpSize(buf) ?? gifSize(buf);
  if (!size) return null;
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height)) return null;
  if (size.width <= 0 || size.height <= 0) return null;
  return size;
}
