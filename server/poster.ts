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
// other origin touch. ⚠ ffmpeg NEVER fetches — it is handed a local file, and
// `-protocol_whitelist file` makes that a property of the invocation rather than
// of the argument (see `ffmpegArgs`). Its own protocol handlers would be a second,
// unguarded network client in the exact process this architecture exists to contain.
//
// ⚠⚠ Best-effort BY CONTRACT. Every failure — no ranges, no index in reach, no
// decodable frame, no ffmpeg, over budget, no decode slot — returns null, and null
// means "a card with no poster", which is a complete state. Nothing here may fail
// a resolve.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from './utils/sharp.js';
import { bufferStream, safeRequest } from './services/linkFetch.js';
import { SlotPool } from './utils/slotPool.js';
import { envInt } from './utils/env.js';
import { contentRangeTotal } from './fetchImage.js';

/** How much of the front to take: enough for a faststart index plus the first keyframe.
 *  The prototype's probe answered real posters from 512 KB heads; 1 MB is margin. */
const HEAD_BYTES = 1024 * 1024;
/** How much of the back to take when the index is not up front. `moov` is an index, not
 *  media — small, but it grows with duration. */
const TAIL_BYTES = 512 * 1024;
/** Wall-clock ceiling for one ffmpeg decode. A container format can describe an enormous
 *  amount of work in very few bytes, so the bound has to be time, not input size. */
/** ⚠ Capped below 2^31 ms: node clamps a longer timer to 1 ms, the exact failure a NaN gave. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const DECODE_TIMEOUT_MS = envInt('LURKER_PREVIEWS_POSTER_TIMEOUT_MS', 5_000, {
  min: 1,
  max: MAX_TIMER_MS,
});
/** Longest edge of the poster. A card thumbnail, not a frame grab for archival. */
const POSTER_MAX_EDGE = 640;

/**
 * The largest frame a decoder may allocate: 8K (7680×4320). ffmpeg's default is INT_MAX,
 * and the allocation happens on the strength of a container header, before a pixel is read
 * — so a few bytes could claim a frame of hundreds of MB inside a 512 MB container where the
 * OOM killer may well pick node over the child.
 */
const MAX_FRAME_PIXELS = 7680 * 4320;
/** The largest single allocation ffmpeg may make. ⚠ An 8K plane of the tone-map chain's
 *  `gbrpf32le` is 7680×4320×4 = 132.7 MB, and the chain fails outright past the cap — measured:
 *  128 MiB made an 8K HDR clip ship its UN-tone-mapped fallback. 160 MiB clears it; the frame
 *  cap above is what bounds the total. */
const MAX_ALLOC_BYTES = 160 * 1024 * 1024;
/** The most pixels a poster can be, for sharp's reads of OUR OWN encoder's output: 640² plus
 *  the even-rounding of `force_divisible_by`. Not a cap on the video; a cap on the JPEG. */
const MAX_POSTER_PIXELS = 2 * POSTER_MAX_EDGE * POSTER_MAX_EDGE;
/** A poster is tens of KB. Child output past this is not a frame, whatever it is. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/**
 * Longest declared file this will build a sparse window for. The origin names the total
 * (Content-Range, or Content-Length on a 200) and `materialize` truncates a file to it; on
 * tmpfs a hole is free, but a self-hoster who drops `--tmpfs /tmp` onto a filesystem without
 * sparse support allocates the whole claim. 4 GiB is past any clip a phone records.
 */
const MAX_DECLARED_TOTAL = 4 * 1024 * 1024 * 1024;

/**
 * Decodes in flight — ffprobe and ffmpeg alike; EVERY child goes through `run`.
 *
 * ⚠⚠ Before this pool the only bound on concurrent children was the resolve pool's twenty
 * slots, and the thread cap below was a quarter of the story: measured on a 16-core host,
 * each `-threads 2` ffmpeg ran FIFTY threads, because that flag capped the decoder alone and
 * the filter graph and the encoder each defaulted to a thread per core. Twenty of those is a
 * thousand threads against `--pids-limit 128`; every spawn past the limit fails EAGAIN and
 * reports as a silently posterless card — and so does every avatar decode and DNS lookup in
 * the same cgroup. Two at a time, each now provably single-threaded, is a bound that holds.
 *
 * A poster that cannot get a slot in time keeps the verdict it has: no poster. Never a
 * failed resolve.
 */
const decodePool = new SlotPool({ size: 2, maxQueued: 20, waitMs: 5_000 });

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
 * filesystem it occupies no blocks. `total` is bounded by MAX_DECLARED_TOTAL before this runs.
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

/** What a child run is bound by: the caller's abort, and where it may look. */
export interface RunContext {
  signal?: AbortSignal;
  /** The temp directory, so a relative path the demuxer might open resolves inside it. */
  cwd?: string;
}

interface RunResult {
  code: number | null;
  stdout: Buffer;
  timedOut: boolean;
}

const NOTHING: RunResult = { code: null, stdout: Buffer.alloc(0), timedOut: false };

/**
 * Run a binary under the decode pool, with a hard timeout, collecting stdout. Never rejects
 * on a non-zero exit — a refusal to decode is an ANSWER here, not an exception.
 *
 * ⚠⚠ Killed on the caller's abort. `server.ts` wraps the whole resolve in a deadline that
 * releases the resolve slot when it fires; before this the child chain it had started kept
 * running to its own end — up to eight ffmpeg/ffprobe runs of DECODE_TIMEOUT_MS each —
 * while the slot was handed to the next caller. "A cap that a timeout quietly lifts is not a
 * cap" (server.ts), and this is the hook that makes the release honest.
 */
async function run(bin: string, args: string[], ctx: RunContext = {}): Promise<RunResult> {
  if (ctx.signal?.aborted) return NOTHING;
  if (!(await decodePool.acquire(ctx.signal))) return NOTHING;
  try {
    if (ctx.signal?.aborted) return NOTHING;
    return await spawnBounded(bin, args, ctx);
  } finally {
    decodePool.release();
  }
}

/** Test seam: the pool, the abort and the output cap are the properties, and none of them
 *  can be seen from a poster. */
export const runForTests = run;

function spawnBounded(
  bin: string,
  args: string[],
  ctx: RunContext,
  timeoutMs = DECODE_TIMEOUT_MS,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'], cwd: ctx.cwd });
    const chunks: Buffer[] = [];
    let seen = 0;
    let timedOut = false;
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = (): void => kill();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (result: RunResult): void => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.stdout.on('data', (c: Buffer) => {
      seen += c.length;
      if (seen > MAX_STDOUT_BYTES) {
        kill();
        return;
      }
      chunks.push(c);
    });
    child.on('error', () => finish({ code: null, stdout: Buffer.alloc(0), timedOut }));
    // ⚠ A killed child's partial output is NOT a frame: a JPEG cut off mid-scan would pass the
    // "did we get bytes" test and ship as a poster.
    child.on('close', (code) =>
      finish({ code, stdout: killed ? Buffer.alloc(0) : Buffer.concat(chunks), timedOut }),
    );
  });
}

/** Is there an ffmpeg to call at all? Checked once; a decoder image always has one, local
 *  dev may not, and the difference must be a missing poster rather than a failing resolve. */
let ffmpegPresent: Promise<boolean> | null = null;
export function ffmpegAvailable(): Promise<boolean> {
  // ⚠ Outside the decode pool and its timeout, and cached only when the answer is definitive:
  // a `-version` that lost a slot or was killed by a busy host's slow start is not "no ffmpeg",
  // and a false cached here is no posters for the life of the process.
  ffmpegPresent ??= spawnBounded('ffmpeg', ['-version'], {}, 30_000).then((r) => {
    if (r.code === 0) return true;
    if (r.timedOut) {
      ffmpegPresent = null;
      return false;
    }
    console.warn('[previews] ffmpeg not found — video/audio cards will have no posters');
    return false;
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
    const stats = await sharp(jpeg, { limitInputPixels: MAX_POSTER_PIXELS }).stats();
    return stats.channels.every((c) => c.stdev < 2);
  } catch {
    // Unreadable by sharp: not this heuristic's call. The cell's signature check is the
    // gate that decides whether bytes get stored at all.
    return false;
  }
}

/**
 * Longest edge clamped on BOTH axes, aspect preserved, never upscaled. The tail of every chain.
 *
 * ⚠ Both axes. `scale='min(640,iw)':-2` capped the width alone, so a 100×60000 frame came out
 * at full height — 42 MP of MJPEG for sharp to read back. `force_original_aspect_ratio=
 * decrease` fits the frame inside the box; `force_divisible_by=2` keeps the encoder's even
 * dimensions, which `-2` used to supply (verified: 1281×721 → 640×360, 100×2000 → 32×640).
 */
export const SCALE_VF = `scale='min(${POSTER_MAX_EDGE},iw)':'min(${POSTER_MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

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
 * The ffprobe invocation. Exported so the test can pin the flags that bound it.
 *
 * ⚠ The same containment flags as ffmpeg's, allocation cap included: ffprobe opens the
 * decoder to read stream info,
 * so it allocates frames and spawns threads exactly as a decode would.
 */
export function ffprobeArgs(file: string): string[] {
  return [
    '-v',
    'error',
    '-max_alloc',
    String(MAX_ALLOC_BYTES),
    '-protocol_whitelist',
    'file',
    '-threads',
    '1',
    '-max_pixels',
    String(MAX_FRAME_PIXELS),
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=color_transfer',
    '-of',
    'default=nw=1:nk=1',
    file,
  ];
}

/**
 * The ffmpeg invocation for one frame. Exported so the test can pin the flags that bound it
 * — a thread cap that only looked like one is how this list came to be written out.
 *
 * ⚠⚠ THREE thread caps, because ffmpeg has three thread pools and `-threads` before `-i`
 * reaches only the first. The decoder takes the input-side `-threads`; the filter graph
 * takes `-filter_threads`; the encoder takes the output-side `-threads`, after `-i`. The
 * last two default to a thread per core, which on a 16-core host made a "`-threads 2`"
 * decode a 50-thread process under a `--pids-limit` that counts threads. One of each: this
 * is ONE frame at card size, not a transcode, and the measured cost of single-threading it
 * is nothing.
 *
 * ⚠ `-protocol_whitelist file`, before `-i`: ffmpeg picks the demuxer from the BYTES, not from
 * the content type the origin declared, and a playlist (HLS, concat) is a valid input whose
 * entries name other files. The default nested whitelist already stops `http:`; this states
 * the policy instead of inheriting it, and drops `data:` and `crypto:` with it. `cwd` is the
 * temp directory for the same reason: a relative segment path resolves there and nowhere else.
 *
 * ⚠ `-max_pixels` and `-max_alloc`: a container header declares the frame size and the
 * decoder allocates it before reading a pixel. ffmpeg's defaults are INT_MAX for both.
 */
export function ffmpegArgs(file: string, ss: string, vf: string): string[] {
  return [
    '-nostdin',
    '-loglevel',
    'error',
    '-max_alloc',
    String(MAX_ALLOC_BYTES),
    '-protocol_whitelist',
    'file',
    '-threads',
    '1',
    '-filter_threads',
    '1',
    '-max_pixels',
    String(MAX_FRAME_PIXELS),
    '-ss',
    ss,
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    vf,
    '-threads',
    '1',
    '-q:v',
    '4',
    '-f',
    'mjpeg',
    'pipe:1',
  ];
}

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
async function needsToneMap(file: string, ctx: RunContext): Promise<boolean> {
  const { stdout } = await run('ffprobe', ffprobeArgs(file), ctx);
  return HDR_TRANSFERS.has(stdout.toString('utf8').trim());
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
async function decodeFrame(
  file: string,
  windowed: boolean,
  vf: string,
  ctx: RunContext,
): Promise<{ jpeg: Buffer; flat: boolean } | null> {
  let flatFallback: Buffer | null = null;
  for (const ss of windowed ? ['0', '0.5'] : ['0.5', '0']) {
    const { stdout } = await run('ffmpeg', ffmpegArgs(file, ss, vf), ctx);
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
export async function posterFilter(file: string, ctx: RunContext = {}): Promise<string> {
  return (await needsToneMap(file, ctx)) ? `${TONEMAP_VF},${SCALE_VF}` : SCALE_VF;
}

/**
 * One decode, tone-mapped when the source needs it and plain when that chain will not run.
 *
 * ⚠⚠ A build without libzimg fails the WHOLE command rather than skipping the filter it
 * cannot run, which would turn "the poster is too bright" into "there is no poster" — a
 * strictly worse outcome, and a silent one, since a missing poster is a supported state.
 * Debian's ffmpeg (the decoder image) has zscale; a self-hoster's may not.
 *
 * ⚠⚠ ONE function rather than the retry written out beside each decode, because written out
 * it covered only the FIRST of the two: the whole-file fallback asked with the tone-mapped
 * chain alone, so on such a build it failed and the caller kept the sparse window's FLAT
 * frame — precisely the frame the whole-file fetch exists to replace. A guard sitting at one
 * of two call sites reads as covering both. (Copilot.)
 */
async function decodeWithFallback(
  file: string,
  windowed: boolean,
  vf: string,
  ctx: RunContext = {},
): Promise<{ jpeg: Buffer; flat: boolean } | null> {
  const frame = await decodeFrame(file, windowed, vf, ctx);
  if (frame || vf === SCALE_VF) return frame;
  return decodeFrame(file, windowed, SCALE_VF, ctx);
}

/** Test seam: the fallback is only reachable with a chain ffmpeg refuses, which the image
 *  this ships in never produces. Exported so an unrunnable chain can be handed to it. */
export const decodeWithFallbackForTests = decodeWithFallback;

/** Ceiling on a WHOLE-file fallback fetch. Matches the relay cap video had before the media
 *  policy retired it — the last size anyone blessed for moving one clip's bytes once. */
const FULL_FETCH_MAX_BYTES = envInt('LURKER_PREVIEWS_POSTER_FULL_FETCH_BYTES', 64 * 1024 * 1024);
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
    const stated =
      typeof fromRange === 'number'
        ? fromRange
        : !ranged && Number.isSafeInteger(declared)
          ? declared
          : null;
    // ⚠ An origin whose stated total is SMALLER than what it has already sent is lying, and a
    // total that was merely clamped up to the bytes in hand would build a sparse file around
    // a claim nothing else about the response supports. No poster.
    if (stated !== null && stated < head.length) return null;
    total = stated ?? head.length;
    if (total > MAX_DECLARED_TOTAL) return null;

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
  const ctx: RunContext = { signal, cwd: dir };
  try {
    const file = await materialize(dir, total, head, tail);
    const windowed = head.length < total;
    // ⚠ Probed once per poster, not per seek attempt — `decodeFrame` tries two offsets.
    let frame = await decodeWithFallback(file, windowed, await posterFilter(file, ctx), ctx);
    // The window didn't hold a real frame (or held only the hole's flat gray). Go get the
    // whole file — through the guard — and let ffmpeg pick its frame with everything there.
    if (windowed && (!frame || frame.flat)) {
      const whole = await fetchWhole(url, dir, total, signal);
      // ⚠ RE-PROBED against the whole file rather than reusing the window's answer. The
      // sparse file can have its stream header inside the hole, and `needsToneMap` fails to
      // `false` when it cannot read one — so a genuinely HDR clip whose header did not make
      // the head fetch would carry that "SDR" verdict into the one decode that has all the
      // bytes. One ffprobe, on a path that has just pulled the entire file over the network.
      if (whole)
        frame =
          (await decodeWithFallback(whole, false, await posterFilter(whole, ctx), ctx)) ?? frame;
    }
    if (!frame) return null;
    const jpeg = frame.jpeg;
    // Measured so the card can reserve the box before the bytes arrive — same reasoning as
    // image dimensions on the resolve path. This JPEG is OUR OWN encoder's output, not origin
    // bytes, but it still goes through sharp's metadata read only, never a decode-and-render.
    try {
      const meta = await sharp(jpeg, { limitInputPixels: MAX_POSTER_PIXELS }).metadata();
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
