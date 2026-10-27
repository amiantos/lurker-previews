// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The ONE sharp import. Every module that decodes goes through here so the loader
// block below is in force wherever libvips can see a byte an origin chose.
//
// ⚠⚠ sharp picks the loader by SNIFFING the bytes, not from the declared type. So the
// `image/svg+xml` refusal in `kindForContentType` and the `format === 'svg'` check after
// `metadata()` in avatar.ts both run AFTER librsvg has already parsed the document to
// report its dimensions — an SVG served as `image/png` reached the parser the allowlist
// exists to keep it from. The 2026 sharp advisories (GHSA-rgj7-g3m4-5g8c libheif,
// GHSA-wq5f-xc86-pv6w librsvg) name `sharp.block()` as the workaround, and it is also the
// right design: a loader this service has no use for should not exist at runtime at all.
//
// What is blocked and why:
//   Svg      — a document format that runs script; never a picture here (see resolve.ts).
//   Tiff     — no browser renders it, so nothing a client could show is lost, and libtiff
//              has the longest CVE record of the bundled decoders.
//   Pdf, Magick, Fits, Openslide, Mat, Nifti, Analyze, Rad, Ppm, Csv, Matrix, Vips —
//              absent from sharp's prebuilt libvips, present in a system one (a self-hoster
//              building against `SHARP_FORCE_GLOBAL_LIBVIPS`); none is an image anyone
//              pastes into IRC. Blocking a loader libvips does not have is a no-op, so the
//              list is written for the larger build.
//
// NOT blocked: Jpeg, Png, Webp, Gif, Heif (AVIF). Those are what the web serves. libheif
// is the other advisory above and stays because AVIF is a real avatar format now; the
// version bump is what addresses it.

import sharp from 'sharp';

/** libvips loader classes refused at runtime. A parent class blocks every subclass
 *  (`VipsForeignLoadSvg` covers the buffer, file and source variants). */
export const BLOCKED_LOADERS: readonly string[] = [
  'VipsForeignLoadSvg',
  'VipsForeignLoadTiff',
  'VipsForeignLoadPdf',
  'VipsForeignLoadMagick',
  'VipsForeignLoadMagick7',
  'VipsForeignLoadFits',
  'VipsForeignLoadOpenslide',
  'VipsForeignLoadMat',
  'VipsForeignLoadNifti',
  'VipsForeignLoadAnalyze',
  'VipsForeignLoadRad',
  'VipsForeignLoadPpm',
  'VipsForeignLoadCsv',
  'VipsForeignLoadMatrix',
  'VipsForeignLoadVips',
];

sharp.block({ operation: [...BLOCKED_LOADERS] });

export default sharp;
