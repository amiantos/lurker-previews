// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Poster frames: one JPEG from a video (or audio cover art), fetched by RANGE
// where the origin allows it, decoded by ffmpeg with a hard deadline.
//
// Carried over from the lurker-thumbnailer prototype (lurker-dev/lurker-thumbnailer,
// never shipped) — the ffmpeg invocation, the sparse-file reconstruction and the
// `moov` atom walk were all proven there against real files: a 9 MB phone `.mov`
// yielded a real first frame from 8.3% of its bytes, a faststart mp4 from 1.8%.
// What changed is WHO fetches: the prototype had bytes POSTed in; this service
// fetches them itself, through the same SSRF-guarded, DNS-pinned client as every
// other origin touch. ⚠ ffmpeg NEVER fetches — it is handed a local file. Its own
// protocol handlers would be a second, unguarded network client in the exact
// process this architecture exists to contain.
//
// ⚠⚠ Best-effort BY CONTRACT. Every failure — no ranges, no index in reach, no
// decodable frame, no ffmpeg, over budget — returns null, and null means "a card
// with no poster", which is a complete state. Nothing here may fail a resolve.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { bufferStream, safeRequest } from './services/linkFetch.js';
import { SlotPool } from './utils/slotPool.js';
import { contentRangeTotal } from './fetchImage.js';

/** How much of the front to take: enough for a faststart index plus the first keyframe.
 *  The prototype's probe answered real posters from 512 KB heads; 1 MB is margin. */
const HEAD_BYTES = 1024 * 1024;
/** How much of the back to take when the index is not up front. `moov` is an index, not
 *  media — small, but it grows with duration. */
const TAIL_BYTES = 512 * 1024;
/** Wall-clock ceiling for one ffmpeg decode. A container format can describe an enormous
 *  amount of work in very few bytes, so the bound has to be time, not input size. */
const DECODE_TIMEOUT_MS = Number(process.env.LURKER_PREVIEWS_POSTER_TIMEOUT_MS ?? 5_000);
/** Longest edge of the poster. A card thumbnail, not a frame grab for archival. */
const POSTER_MAX_EDGE = 640;

export interface PosterOptions {
  headBytes?: number;
  tailBytes?: number;
}

export interface Poster {
  jpeg: Buffer;
  width: number | null;
  height: number | null;
}

/**
 * Walk top-level ISO-BMFF atoms looking for `moov`.
 *
 * ⚠ Only the TOP level, and only as far as the buffer goes. This is not a parser — it answers
 * one question ("is the index in the bytes I already hold?") and any uncertainty resolves to
 * "no", which costs one extra range request and never a wrong answer.
 */
export function hasMoovInHead(buf: Buffer): boolean {
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    if (type === 'moov') return true;
    // 0 = "to end of file", 1 = 64-bit size in the next 8 bytes. Both mean the next atom is
    // either absent or beyond anything we can cheaply step over, so stop.
    if (size === 0) return false;
    if (size === 1) {
      if (off + 16 > buf.length) return false;
      const big = buf.readBigUInt64BE(off + 8);
      if (big <= 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      off += Number(big);
      continue;
    }
    if (size < 8) return false;
    off += size;
  }
  return false;
}

/**
 * Rebuild the fetched byte windows as a SPARSE file at true offsets.
 *
 * ⚠⚠ THIS IS THE `moov` GOTCHA. A faststart MP4 puts its index at the front; a `.mov` straight
 * off a phone routinely puts it at the END. So a poster for phone video needs the tail (to find
 * the index) AND the head (where the first keyframe's bytes actually live) — and those two
 * ranges cannot simply be concatenated, because every offset inside `moov` is absolute against
 * the original file. Writing them into a file of the ORIGINAL LENGTH preserves those offsets
 * exactly; the hole in between is never read for a first-frame decode, and on any modern
 * filesystem it occupies no blocks.
 */
async function materialize(
  dir: string,
  total: number,
  head: Buffer,
  tail: Buffer | null,
): Promise<string> {
  const file = path.join(dir, 'in.bin');
  const fh = await open(file, 'w+');
  try {
    await fh.write(head, 0, head.length, 0);
    if (tail && tail.length) {
      const at = total - tail.length;
      if (at < 0) throw new Error('tail longer than the declared total');
      await fh.write(tail, 0, tail.length, at);
    }
    // Extend to the full length so the container's own offsets remain valid even when the
    // trailing bytes were never sent.
    await fh.truncate(total);
  } finally {
    await fh.close();
  }
  return file;
}

/** Run a binary with a hard timeout, collecting stdout. Never rejects on a non-zero exit —
 *  a refusal to decode is an ANSWER here, not an exception. */
function run(
  bin: string,
  args: string[],
): Promise<{ code: number | null; stdout: Buffer; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, DECODE_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: Buffer.alloc(0), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), timedOut });
    });
  });
}

/** Is there an ffmpeg to call at all? Checked once; a decoder image always has one, local
 *  dev may not, and the difference must be a missing poster rather than a failing resolve. */
let ffmpegPresent: Promise<boolean> | null = null;
export function ffmpegAvailable(): Promise<boolean> {
  ffmpegPresent ??= run('ffmpeg', ['-version']).then((r) => {
    if (r.code !== 0) {
      console.warn('[previews] ffmpeg not found — video/audio cards will have no posters');
    }
    return r.code === 0;
  });
  return ffmpegPresent;
}

/**
 * A frame with (almost) nothing in it — every channel's deviation near zero.
 *
 * ⚠⚠ This is what a hole in the sparse window DECODES TO. ffmpeg seeks by the index, and the
 * index happily names a sample whose bytes were never fetched; the hole reads as zeros, some
 * decoders (HEVC, with "Invalid NAL unit size" grumbles) still emit a frame, and that frame is
 * a flat gray card — 2 KB of JPEG that passes every "did we get output" test. Found in local
 * QA as a blank gray poster on a 46 MB phone clip. A flat frame is only ever a LAST resort,
 * because it is also — rarely — what a genuinely black clip opens with.
 */
export async function looksFlat(jpeg: Buffer): Promise<boolean> {
  try {
    const stats = await sharp(jpeg).stats();
    return stats.channels.every((c) => c.stdev < 2);
  } catch {
    // Unreadable by sharp: not this heuristic's call. The cell's signature check is the
    // gate that decides whether bytes get stored at all.
    return false;
  }
}

/**
 * Decode one frame to JPEG.
 *
 * ⚠ `-ss` BEFORE `-i` so the seek is done by demuxing rather than by decoding every frame up to
 * the mark — on a long file the difference is seconds against milliseconds.
 *
 * ⚠ The seek ORDER depends on how much of the file we hold. For a whole file, 0.5 s first: some
 * encoders have no decodable frame exactly at zero, and a seek to 0 is frequently a no-op. For a
 * WINDOWED file — head and maybe tail, hole in between — frame 0 is the only sample whose bytes
 * are guaranteed inside the head, so it goes first; 0.5 s may be past the window entirely on a
 * high-bitrate clip, which is precisely the flat-gray case `looksFlat` exists to catch.
 */
/** Longest edge clamped, aspect preserved, never upscaled. The tail of every chain. */
const SCALE_VF = `scale='min(${POSTER_MAX_EDGE},iw)':-2`;

/**
 * The HDR→SDR tone map, in front of the scale.
 *
 * ⚠⚠ WITHOUT THIS AN HDR FRAME IS DECODED AS THOUGH IT WERE bt709, which is simply the
 * wrong curve: PQ (`smpte2084`) and HLG (`arib-std-b67`) both encode luminance quite
 * differently from a gamma-2.2 ramp, and reading one as the other lands the whole picture
 * at the wrong brightness. lurker-previews#1, reported as "HDR video posters are too
 * bright" — which is the HLG direction, and the one phone cameras record in.
 *
 * ⚠⚠ `hable`, CHOSEN ON REAL FOOTAGE, and the first answer here was wrong. A synthetic
 * fixture — an SDR ramp pushed through PQ at a 1000-nit peak and back — ranked `mobius`
 * nearest the source (YAVG 165.9 against 177.9, where `hable` gave 118.1), and that ranking
 * does not survive contact with camera HDR. On an actual HLG clip (HEVC 4K 10-bit, bt2020,
 * `arib-std-b67`) the operator's verdict was that `hable` alone looks like the footage and
 * `mobius` and `reinhard` are both visibly off — they LIFT the picture, which is the very
 * complaint this fixes:
 *
 *     no tone map  YAVG 127.0     hable  123.4     reinhard  148.6     mobius  155.1
 *
 * The synthetic ramp misleads because its values sit low on the transfer curve and never
 * exercise the highlight roll-off that dominates a real frame; `mobius`'s "leave SDR-safe
 * values alone" is close to a no-op there and a brightening almost everywhere else. Trust
 * the clip, not the ramp — and note that "closest YAVG to the untone-mapped frame" is not
 * the target either, it is just where the right answer happened to land here.
 *
 * ⚠⚠ npl=75 UNDERSTATES the source on purpose, and that is the whole of the brightness
 * trim. `npl` is the nominal peak luminance zscale assumes when it takes HLG to linear
 * light, so a lower figure means less of the signal reads as "above SDR" and `hable`
 * compresses less — the frame comes out brighter without touching its black point or its
 * highlight roll-off. At a truthful npl=100 the operator's read on real footage was "a hair
 * dark"; 75 was picked by eye against the same clip (YAVG 123.4 → 132.8).
 *
 * ⚠ Preferred over a `gamma` lift bolted on after the curve, which was the other candidate
 * and measured almost the same (130.1). A trim inside the colour pipeline stays a colour
 * decision — it keeps the roll-off headroom the tone map is there to manage — where a gamma
 * tweak on the finished frame also raises the shadows of every clip that passes through.
 *
 */
const TONEMAP_VF =
  'zscale=t=linear:npl=75,format=gbrpf32le,zscale=p=bt709,' +
  'tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/** Transfer characteristics that mean "not SDR", per ffprobe's spelling. */
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

/**
 * Does this file need tone mapping?
 *
 * ⚠ Answered from the stream's own tag rather than guessed from the pixels, and it decides
 * only whether to ADD a filter — an SDR file must reach ffmpeg exactly as it does today,
 * since running a tone map over bt709 content would alter a picture that is already right.
 *
 * ⚠ Fails to `false`, which is the current behaviour: a probe that cannot answer (no
 * ffprobe, a container header still inside the sparse window's hole, a codec it cannot
 * parse) must not cost us a poster we would otherwise have produced.
 */
async function needsToneMap(file: string): Promise<boolean> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=color_transfer',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  return HDR_TRANSFERS.has(stdout.toString('utf8').trim());
}

async function decodeFrame(
  file: string,
  windowed: boolean,
  vf: string = SCALE_VF,
): Promise<{ jpeg: Buffer; flat: boolean } | null> {
  let flatFallback: Buffer | null = null;
  for (const ss of windowed ? ['0', '0.5'] : ['0.5', '0']) {
    const { stdout } = await run('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      // ⚠⚠ Capped, because ffmpeg's default is one decode thread PER CORE and the container
      // runs under --pids-limit, which counts THREADS. On a 16-core host an uncapped decode
      // plus node's own pool overran a 64-pid budget and every thread spawn failed EAGAIN —
      // which this path reports as "no poster", silently, since a missing poster is a
      // supported state. Found in local QA as "no posters anywhere" with nothing in any log.
      // Two threads is plenty: this is ONE frame at card size, not a transcode.
      '-threads',
      '2',
      '-ss',
      ss,
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      vf,
      '-q:v',
      '4',
      '-f',
      'mjpeg',
      'pipe:1',
    ]);
    // ⚠ Judged on OUTPUT, not on the exit code. ffmpeg exits non-zero on a truncated input while
    // still having written a perfectly good frame — which is the normal case here, since the
    // file it was handed is deliberately incomplete.
    if (stdout.length === 0) continue;
    if (!(await looksFlat(stdout))) return { jpeg: stdout, flat: false };
    flatFallback ??= stdout;
  }
  // Every seek that produced anything produced a flat card. The CALLER decides what that
  // means: for a whole file it IS the video's opening; for a windowed one it is more likely
  // the hole, and grounds to go get the real bytes.
  return flatFallback ? { jpeg: flatFallback, flat: true } : null;
}

/**
 * The `-vf` chain for one file: tone-mapped when the stream says it is HDR, plain otherwise.
 *
 * ⚠ Exported for the test, and it is the right seam to expose rather than `needsToneMap`.
 * What can break here is the WIRING as much as the probe — a chain built and then not
 * passed to ffmpeg looks identical from the outside — and a perceptual assertion is not
 * available to test either half: synthetic fixtures do not behave like camera HDR (an SDR
 * ramp merely tagged HLG tone-maps to within 0.13 of itself), so a brightness comparison
 * either measures swscale's matrix conversion instead or measures nothing at all. Both were
 * tried. This asserts the decision and the wiring, which are the parts that can regress
 * silently; the picture itself wants a real clip and a pair of eyes.
 */
export async function posterFilter(file: string): Promise<string> {
  return (await needsToneMap(file)) ? `${TONEMAP_VF},${SCALE_VF}` : SCALE_VF;
}

/** Ceiling on a WHOLE-file fallback fetch. Matches the relay cap video had before the media
 *  policy retired it — the last size anyone blessed for moving one clip's bytes once. */
const FULL_FETCH_MAX_BYTES = Number(
  process.env.LURKER_PREVIEWS_POSTER_FULL_FETCH_BYTES ?? 64 * 1024 * 1024,
);
/**
 * Whole-file fetches in flight. ⚠ /tmp is tmpfs in the shipped container, so a "file" here is
 * RAM — twenty concurrent 46 MB pulls is the memory limit exceeded, not a busy disk. Two at a
 * time; a resolve that can't get a slot just keeps the window verdict it already has.
 */
const fullFetchPool = new SlotPool({ size: 2, maxQueued: 8, waitMs: 2_000 });

/**
 * Fetch the ENTIRE file to disk, through the guard, byte-capped and deadline-bounded.
 *
 * ⚠ This exists because the window trick has an honest failure mode (a 4K HEVC clip's 0.5 s
 * is ~1.5 MB of interleaved stream — past any sane head window), and the fix for "we didn't
 * hold the right bytes" is holding all of them, NOT letting ffmpeg fetch: ffmpeg's own HTTP
 * client would bypass the DNS-pinned guard entirely, and on a host with no egress firewall
 * that guard is the only one there is. Cost is bounded and rare: once per URL per cell TTL,
 * only when the cheap path came up flat, never for files past the cap.
 */
async function fetchWhole(
  url: URL,
  dir: string,
  total: number,
  signal: AbortSignal,
): Promise<string | null> {
  if (!Number.isFinite(total) || total > FULL_FETCH_MAX_BYTES) return null;
  if (!(await fullFetchPool.acquire())) return null;
  try {
    const res = await safeRequest(url, { accept: '*/*', streaming: true, signal });
    if (res.status !== 200) {
      res.stream.destroy();
      return null;
    }
    const file = path.join(dir, 'whole.bin');
    const out = createWriteStream(file);
    let seen = 0;
    await new Promise<void>((resolve, reject) => {
      res.stream.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        // Counted on bytes actually seen — the origin already stated a total once, but a
        // stream that keeps going past it is exactly the origin this cap is about.
        if (seen > FULL_FETCH_MAX_BYTES) {
          res.stream.destroy();
          reject(new Error('over the full-fetch cap'));
        }
      });
      res.stream.on('error', reject);
      out.on('error', reject);
      res.stream.pipe(out);
      out.on('finish', resolve);
    });
    return file;
  } catch {
    return null;
  } finally {
    fullFetchPool.release();
  }
}

/**
 * A poster for the video/audio at `url`, or null.
 *
 * The fetch strategy, measured in the prototype and kept:
 *   1. Range GET for the head. 206 is the ONLY proof of range support — an origin may
 *      advertise `Accept-Ranges: bytes` and still answer 200 with the whole body.
 *   2. If the whole file arrived, or the `moov` walk finds the index up front, stop.
 *   3. Otherwise one more range GET for the tail, where a phone clip keeps its index.
 *
 * An origin that ignores ranges gets its file read to the head cap and no further —
 * if that prefix doesn't decode (index at the end of a big file), the answer is a
 * posterless card, not a 44 MB download.
 */
export async function posterForUrl(
  url: URL,
  signal: AbortSignal,
  opts: PosterOptions = {},
): Promise<Poster | null> {
  if (!(await ffmpegAvailable())) return null;
  const headBytes = opts.headBytes ?? HEAD_BYTES;
  const tailBytes = opts.tailBytes ?? TAIL_BYTES;

  let head: Buffer;
  let tail: Buffer | null = null;
  let total: number;
  try {
    const res = await safeRequest(url, {
      accept: '*/*',
      range: `bytes=0-${headBytes - 1}`,
      signal,
    });
    if (res.status !== 200 && res.status !== 206) {
      res.stream.destroy();
      return null;
    }
    const ranged = res.status === 206;
    // ⚠ maxBytes matters on BOTH branches: a 206 body should already be head-sized, but an
    // origin that answered 200 is sending the whole file and this cap is what makes that a
    // bounded read instead of a download.
    head = (await bufferStream(res, { maxBytes: headBytes })).body;
    if (head.length === 0) return null;

    const fromRange = ranged
      ? contentRangeTotal(res.headers['content-range'] as string | undefined)
      : 'unknown';
    const declared = Number(res.headers['content-length']);
    total =
      typeof fromRange === 'number'
        ? fromRange
        : !ranged && Number.isSafeInteger(declared)
          ? declared
          : head.length;
    if (total < head.length) total = head.length;

    const wholeFile = head.length >= total;
    if (!wholeFile && ranged && !hasMoovInHead(head)) {
      // The `.mov`-off-a-phone case: the index is at the end, so take the back too.
      const from = Math.max(0, total - tailBytes);
      const tailRes = await safeRequest(url, {
        accept: '*/*',
        range: `bytes=${from}-${total - 1}`,
        signal,
      });
      if (tailRes.status === 206) {
        tail = (await bufferStream(tailRes, { maxBytes: tailBytes })).body;
      } else {
        tailRes.stream.destroy();
      }
    }
  } catch {
    // A refused redirect, a reset, a deadline — the poster is optional and the card is not.
    return null;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'poster-'));
  try {
    const file = await materialize(dir, total, head, tail);
    const windowed = head.length < total;
    // ⚠ Probed once per poster, not per seek attempt — `decodeFrame` tries two offsets.
    const vf = await posterFilter(file);
    let frame = await decodeFrame(file, windowed, vf);
    // ⚠⚠ A build without libzimg fails the WHOLE command rather than skipping the filter it
    // cannot run, which would turn "the poster is too bright" into "there is no poster" —
    // a strictly worse outcome, and a silent one, since a missing poster is a supported
    // state. Debian's ffmpeg (the decoder image) has zscale; a self-hoster's may not, so
    // the plain chain is tried before giving up.
    if (!frame && vf !== SCALE_VF) frame = await decodeFrame(file, windowed, SCALE_VF);
    // The window didn't hold a real frame (or held only the hole's flat gray). Go get the
    // whole file — through the guard — and let ffmpeg pick its frame with everything there.
    if (windowed && (!frame || frame.flat)) {
      const whole = await fetchWhole(url, dir, total, signal);
      if (whole) frame = (await decodeFrame(whole, false, vf)) ?? frame;
    }
    if (!frame) return null;
    const jpeg = frame.jpeg;
    // Measured so the card can reserve the box before the bytes arrive — same reasoning as
    // image dimensions on the resolve path. This JPEG is OUR OWN encoder's output, not origin
    // bytes, but it still goes through sharp's metadata read only, never a decode-and-render.
    try {
      const meta = await sharp(jpeg).metadata();
      return { jpeg, width: meta.width ?? null, height: meta.height ?? null };
    } catch {
      return { jpeg, width: null, height: null };
    }
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
