// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { scrapeMeta, readOEmbed, decodeEntities, decodeBody } from './linkMeta.js';

describe('decodeEntities', () => {
  it('decodes the named entities that show up in titles', () => {
    expect(decodeEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeEntities('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeEntities('it&apos;s')).toBe("it's");
    expect(decodeEntities('a &mdash; b')).toBe('a — b');
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeEntities('caf&#233;')).toBe('café');
    expect(decodeEntities('caf&#xe9;')).toBe('café');
    expect(decodeEntities('&#x1F600;')).toBe('😀');
  });

  it('leaves unknown and malformed references alone rather than mangling them', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
    // A lone surrogate would throw fromCodePoint; it must survive as literal text.
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeEntities('&#999999999;')).toBe('&#999999999;');
  });

  it('does not let a decimal reference carry hex letters', () => {
    // ⚠ Regression guard, found by Copilot. A combined `#x?[0-9a-f]+` alternative let the
    // DECIMAL branch match hex digits, and `parseInt(body, 10)` prefix-parsed the result —
    // `&#99f;` decoded to `c`, `&#65a;` to `A`. The test above says malformed references stay
    // literal; these were silently decoding to whatever their numeric prefix happened to mean.
    expect(decodeEntities('&#99f;')).toBe('&#99f;');
    expect(decodeEntities('&#65a;')).toBe('&#65a;');
    expect(decodeEntities('&#12e;')).toBe('&#12e;');
    // The well-formed cases both still decode, in either case.
    expect(decodeEntities('&#65;')).toBe('A');
    expect(decodeEntities('&#x41;')).toBe('A');
    expect(decodeEntities('&#X41;')).toBe('A');
  });

  it('does not double-decode', () => {
    // A site that double-escapes gets `&amp;` back, not `&`. Decoding twice
    // would be a mangling risk for everyone else.
    expect(decodeEntities('a &amp;amp; b')).toBe('a &amp; b');
  });

  it('decodes the accented entities that non-English metadata is full of', () => {
    // ⚠ Regression guard. The table was punctuation-only, so this rendered LITERALLY in the
    // card — the exact defect decodeEntities exists to prevent, on every French, German,
    // Spanish and Nordic page.
    expect(decodeEntities('Caf&eacute; M&uuml;ller')).toBe('Café Müller');
    expect(decodeEntities('&Aring;ngstr&ouml;m &ccedil;a &ntilde;')).toBe('Ångström ça ñ');
    expect(decodeEntities('&copy; 2026 &mdash; 50&deg;')).toBe('© 2026 — 50°');
  });

  it('respects entity case, which selects a different character', () => {
    expect(decodeEntities('&eacute; vs &Eacute;')).toBe('é vs É');
    expect(decodeEntities('&auml; vs &Auml;')).toBe('ä vs Ä');
  });

  it('does not read through to Object.prototype', () => {
    // ⚠⚠ Regression guard. As a plain object literal the table's lookup walked the prototype
    // chain, and `?? match` accepted what it found because a function is neither null nor
    // undefined — so native-code source text was injected into user-facing card text and into
    // an og:image URL the server then resolved and fetched.
    expect(decodeEntities('Rock &constructor; Roll')).toBe('Rock &constructor; Roll');
    expect(decodeEntities('&toString; &valueOf; &hasOwnProperty;')).toBe(
      '&toString; &valueOf; &hasOwnProperty;',
    );
  });

  it('refuses to mint control characters', () => {
    // ⚠⚠ Regression guard. U+0003 is mIRC colour and U+0002 is mIRC bold, and Lurker's own
    // renderer parses them — so a scraped page controlled formatting in the message list. A
    // NUL additionally truncates in any C-string consumer of the SQLite column. The whitespace
    // collapse removes none of these: `\s` matches neither C0 below \t nor the C1 range.
    expect(decodeEntities('a&#3;04red&#0;NUL&#2;bold')).toBe('a&#3;04red&#0;NUL&#2;bold');
    expect(decodeEntities('&#x1b;[31m')).toBe('&#x1b;[31m');
    expect(decodeEntities('&#127; &#x85;')).toBe('&#127; &#x85;');
    // The three legitimate whitespace controls still decode.
    expect(decodeEntities('a&#9;b&#10;c&#13;d')).toBe('a\tb\nc\rd');
  });
});

describe('scrapeMeta', () => {
  it('prefers Open Graph over Twitter Card over <title>', () => {
    const meta = scrapeMeta(`
      <html><head>
        <title>Tab Title</title>
        <meta name="twitter:title" content="Twitter Title">
        <meta property="og:title" content="OG Title">
      </head><body></body></html>`);
    expect(meta.title).toBe('OG Title');
  });

  it('falls back down the chain when the preferred tag is absent', () => {
    expect(scrapeMeta('<head><title>Only Title</title></head>').title).toBe('Only Title');
    expect(scrapeMeta('<head><meta name="twitter:title" content="Tw"></head>').title).toBe('Tw');
  });

  it('reads attributes in any order and with any quoting', () => {
    const meta = scrapeMeta(`<head>
      <meta content='Single Quoted' property='og:title'>
      <meta property=og:site_name content=Unquoted>
    </head>`);
    expect(meta.title).toBe('Single Quoted');
    expect(meta.siteName).toBe('Unquoted');
  });

  it('does not take a twitter:site handle as a site name', () => {
    // ⚠ `twitter:site` is an @handle naming the ACCOUNT that owns the card, not the site. As a
    // fallback it put `@nytimes` in the card's site slot for every page with a Twitter card and
    // no og:site_name. Absent is the right answer: the caller falls back to the hostname, which
    // is always accurate and is never somebody's username.
    const meta = scrapeMeta(`<head>
      <meta name="twitter:site" content="@nytimes">
      <meta name="twitter:title" content="An Article">
    </head>`);
    expect(meta.siteName).toBeUndefined();
    expect(meta.title).toBe('An Article');
  });

  it('takes the first og:image when a page lists several', () => {
    const meta = scrapeMeta(`<head>
      <meta property="og:image" content="https://e.test/first.png">
      <meta property="og:image" content="https://e.test/second.png">
    </head>`);
    expect(meta.imageUrl).toBe('https://e.test/first.png');
  });

  it('prefers og:image:secure_url over og:image', () => {
    const meta = scrapeMeta(`<head>
      <meta property="og:image" content="http://e.test/plain.png">
      <meta property="og:image:secure_url" content="https://e.test/secure.png">
    </head>`);
    expect(meta.imageUrl).toBe('https://e.test/secure.png');
  });

  it('is not fooled by a hyphen-prefixed attribute of the same name', () => {
    // ⚠ `\bcontent` matches INSIDE `data-content` — a hyphen is a non-word character, so the
    // boundary holds there — and the first match won, so the card showed the placeholder.
    const meta = scrapeMeta(
      `<head><meta property="og:title" data-content="Loading…" content="Real Title"></head>`,
    );
    expect(meta.title).toBe('Real Title');
  });

  it('is not fooled by data-name or data-type either', () => {
    const meta = scrapeMeta(
      `<head><meta data-name="decoy" name="twitter:title" content="Tw"></head>`,
    );
    expect(meta.title).toBe('Tw');

    // `type` vs `data-type` in the oEmbed scan could hide an endpoint entirely.
    const oembed = scrapeMeta(
      `<head><link rel="alternate" data-type="text/xml+oembed" ` +
        `type="application/json+oembed" href="https://e.test/o"></head>`,
    );
    expect(oembed.oembedUrl).toBe('https://e.test/o');
  });

  it('ignores meta tags that live in the body', () => {
    // A stray <meta> inside a third-party embed must not win over the head.
    const meta = scrapeMeta(`
      <head><meta property="og:title" content="Real"></head>
      <body><meta property="og:title" content="Injected"></body>`);
    expect(meta.title).toBe('Real');
  });

  it('discovers an oEmbed endpoint', () => {
    const meta = scrapeMeta(`<head>
      <link rel="alternate" type="application/json+oembed" href="https://e.test/oembed?url=x">
    </head>`);
    expect(meta.oembedUrl).toBe('https://e.test/oembed?url=x');
  });

  it('ignores the XML oEmbed variant, which we do not parse', () => {
    const meta = scrapeMeta(`<head>
      <link rel="alternate" type="text/xml+oembed" href="https://e.test/oembed.xml">
    </head>`);
    expect(meta.oembedUrl).toBeUndefined();
  });

  it('finds both an oEmbed endpoint and an image_src whatever their order', () => {
    // ⚠ Regression guard. The loop `break`s on the first oEmbed-typed tag, so the same document
    // produced a different card depending purely on tag order — and PR 4 returns `unavailable`
    // for a page with neither title nor image, so a page whose best-effort oEmbed fetch failed
    // got no card at all and was negative-cached.
    const oembedFirst = scrapeMeta(`<head>
      <link rel="alternate" type="application/json+oembed" href="https://e.test/o">
      <link rel="image_src" href="https://e.test/i.png">
    </head>`);
    const imageFirst = scrapeMeta(`<head>
      <link rel="image_src" href="https://e.test/i.png">
      <link rel="alternate" type="application/json+oembed" href="https://e.test/o">
    </head>`);
    expect(oembedFirst).toEqual(imageFirst);
    expect(oembedFirst.oembedUrl).toBe('https://e.test/o');
    expect(oembedFirst.imageUrl).toBe('https://e.test/i.png');
  });

  it('does not let an href-less oEmbed link hide a valid one', () => {
    const meta = scrapeMeta(`<head>
      <link rel="alternate" type="application/json+oembed">
      <link rel="alternate" type="application/json+oembed" href="https://e.test/real">
    </head>`);
    expect(meta.oembedUrl).toBe('https://e.test/real');
  });

  it('matches rel as a token list, not as a substring', () => {
    // `includes('alternate')` accepted `notalternateatall`; a real rel is space-separated.
    expect(
      scrapeMeta(
        '<head><link rel="notalternateatall" type="application/json+oembed" href="https://e.test/o"></head>',
      ).oembedUrl,
    ).toBeUndefined();
    expect(
      scrapeMeta(
        '<head><link rel="alternate canonical" type="application/json+oembed" href="https://e.test/o"></head>',
      ).oembedUrl,
    ).toBe('https://e.test/o');
  });

  it('decodes entities and collapses whitespace in text fields', () => {
    const meta = scrapeMeta(
      `<head><meta property="og:description" content="Tom &amp; Jerry\n   go   west"></head>`,
    );
    expect(meta.description).toBe('Tom & Jerry go west');
  });

  it('drops fields that decode to nothing', () => {
    const meta = scrapeMeta(`<head><meta property="og:title" content="   "></head>`);
    expect(meta.title).toBeUndefined();
  });

  it('returns an empty result for a document with no metadata', () => {
    const meta = scrapeMeta('<html><body><p>hello</p></body></html>');
    expect(meta.title).toBeUndefined();
    expect(meta.imageUrl).toBeUndefined();
  });

  it('OMITS absent fields rather than setting them undefined', () => {
    // ⚠⚠ Regression guard, and the bite is at the merge PR 4 writes. Every field used to be
    // assigned unconditionally, so the result always carried five keys — and
    // `{...oembedValues, ...scrapeMeta(html)}` evaluated to all-undefined, silently destroying
    // every oEmbed field the spread was meant to fall back to. JSON.stringify hides it, so it
    // would never show up in a logged payload either.
    const meta = scrapeMeta('<html><body><p>hello</p></body></html>');
    expect(Object.keys(meta)).toEqual([]);
    expect('imageUrl' in meta).toBe(false);
    const fromOEmbed = { title: 'from oEmbed', imageUrl: 'https://i.test/t.jpg' };
    expect({ ...fromOEmbed, ...meta }.title).toBe('from oEmbed');
  });

  it('treats a whitespace-only value as absent, not as an empty string', () => {
    // ⚠ `new URL('', 'https://site.test/article')` resolves to the PAGE — so an empty imageUrl
    // made the server fetch an HTML document as though it were the preview image.
    const meta = scrapeMeta('<head><meta property="og:image" content="   "></head>');
    expect('imageUrl' in meta).toBe(false);
  });

  it('keeps a tag whose attribute value contains an unescaped >', () => {
    // ⚠ Regression guard. `[^>]*>` cut the tag at the first `>` even inside a quoted value, and
    // the truncated remainder matched no attribute — so the tag was DROPPED, not truncated.
    // Breadcrumb titles and `=>` in a description are routine.
    const meta = scrapeMeta(
      '<head><meta property="og:title" content="Settings > Privacy"><title>Fallback</title></head>',
    );
    expect(meta.title).toBe('Settings > Privacy');
    const img = scrapeMeta(
      '<head><meta property="og:image" content="https://e.test/a?w=1>2"></head>',
    );
    expect(img.imageUrl).toBe('https://e.test/a?w=1>2');
  });

  it('does not let one attribute value impersonate another', () => {
    // ⚠⚠ Regression guard, and the sharpest of the parser bugs: the value chosen here becomes
    // a URL the SERVER fetches. `attr()` searched the whole tag for `name=`, first match wins,
    // so text inside an EARLIER attribute's value shadowed the real attribute. The
    // `(?:^|[\s"'])` boundary that shipped as the fix for `data-content` did not close it — a
    // space inside any preceding value satisfies it. ipGuard refuses this address downstream,
    // so it was never a live SSRF, but a scraped page does not get to pick the target.
    const oembed = scrapeMeta(
      '<head><link rel="alternate" title="pick href=http://169.254.169.254/latest/meta-data/" ' +
        'type="application/json+oembed" href="https://real.test/oembed"></head>',
    );
    expect(oembed.oembedUrl).toBe('https://real.test/oembed');

    const img = scrapeMeta(
      '<head><meta property="og:image" data-x="a href=x content=https://evil.test/x.png" ' +
        'content="https://real.test/ok.png"></head>',
    );
    expect(img.imageUrl).toBe('https://real.test/ok.png');

    const title = scrapeMeta(
      '<head><meta property="og:title" data-page="hello content=EVIL world" content="Real Title"></head>',
    );
    expect(title.title).toBe('Real Title');

    // The ROUTING key was shadowable too, promoting a description over the real <title>.
    const routed = scrapeMeta(
      '<head><meta name="description" content="see property=og:title now"><title>Real</title></head>',
    );
    expect(routed.title).toBe('Real');
  });

  it('ends the head at the first non-head element, since <body> is optional', () => {
    // ⚠⚠ Regression guard, and a content-injection path rather than a cosmetic one. HTML5
    // makes both `<body>` and `</head>` optional, and plenty of real pages omit them — so
    // searching for the tag meant the ENTIRE document counted as head. On any forum, wiki or
    // paste site that echoes user markup, that let a commenter set the preview title and image
    // for every channel the link was pasted into.
    // ⚠ Note the fixture carries NEITHER `</head>` NOR `<body>`. An earlier version of this
    // test included `</head>`, which ends the scan by itself — so it passed with the rule
    // reverted and guarded nothing. Both tags are optional and pages that omit one omit both.
    const meta = scrapeMeta(
      '<html><head><title>Real Page</title>\n<p>a user post follows</p>\n' +
        '<meta property="og:title" content="INJECTED BY A COMMENTER">' +
        '<meta property="og:image" content="https://evil.test/x.png">',
    );
    expect(meta.title).toBe('Real Page');
    expect('imageUrl' in meta).toBe(false);
  });

  it('is not fooled by markup inside a script or a comment', () => {
    // ⚠ Regression guards, in both directions. A `<body>` in a script string used to truncate
    // the head and lose everything; a commented-out `<meta>` used to win the first-wins race
    // against the real one, and staging tags left commented out in production markup are
    // common; an inline SVG `<title>` used to shadow the document title.
    expect(
      scrapeMeta(
        '<head><script>var s="<body>";</script><meta property="og:title" content="Real"></head>',
      ).title,
    ).toBe('Real');
    // ⚠ TWO tags inside the comment, deliberately. With one, the `<!doctype>` branch happens to
    // skip to the first `>` and lands past it, so a single-tag fixture passed even with comment
    // handling removed. The second tag is what a `>`-seeking skip leaks.
    expect(
      scrapeMeta(
        '<head><!-- <meta property="og:title" content="Commented A">' +
          '<meta property="og:title" content="Commented B"> -->' +
          '<meta property="og:title" content="Real"></head>',
      ).title,
    ).toBe('Real');
    expect(
      scrapeMeta('<head><svg><title>icon</title></svg><title>Real Page Title</title></head>').title,
    ).toBe('Real Page Title');
  });

  it('scans a hostile document in linear time', () => {
    // ⚠⚠ Regression guard for an unauthenticated remote DoS. `/<meta\b[^>]*>/gi` rescanned to
    // end-of-string from every start position when no `>` was present: measured at 15,138 ms
    // through this function at the real 512 KB cap, doubling cleanly with input size. The
    // server is one process with no yield point here, so a single pasted link stalled every
    // user's IRC socket and WS frames for as long as it ran, and re-pasting re-triggered it.
    // The bound is deliberately loose — the point is linear vs quadratic, not a stopwatch.
    const hostile = '<meta '.repeat(Math.floor((512 * 1024) / 6));
    const started = performance.now();
    scrapeMeta(hostile);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('keeps the site-designated primary image when secure_url belongs to a later one', () => {
    // ⚠ `og:image:secure_url` is a sub-property of the og:image PRECEDING it, not a
    // document-level field. Read flat and preferred outright, it defeated the "first og:image
    // wins" rule — the shape a CMS emits when a hero image is followed by per-article images
    // that each carry their own secure_url.
    const meta = scrapeMeta(`<head>
      <meta property="og:image" content="https://good.test/primary.png">
      <meta property="og:image" content="http://other.test/second.png">
      <meta property="og:image:secure_url" content="https://other.test/second.png">
    </head>`);
    expect(meta.imageUrl).toBe('https://good.test/primary.png');
  });

  it('reads the declared shape of the card image', () => {
    // The client picks between a hero band and a 72px chip from this pair and nothing else, so
    // its absence is a real answer ("no declared shape") rather than a missing field.
    const meta = scrapeMeta(`<head>
      <meta property="og:image" content="https://e.test/card.png">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
    </head>`);
    expect(meta.imageWidth).toBe(1200);
    expect(meta.imageHeight).toBe(630);
  });

  it('attaches width and height to the og:image they FOLLOW', () => {
    // ⚠⚠ Same defect shape as the secure_url case above, and worse to diagnose: a CMS emitting a
    // hero image and then per-article ones declares a size for each, so read flat the LAST
    // article's dimensions describe the FIRST image's picture. Nothing about the URL looks wrong
    // — the card just renders a logo as a stretched band, or an article as a chip.
    const meta = scrapeMeta(`<head>
      <meta property="og:image" content="https://good.test/primary.png">
      <meta property="og:image:width" content="256">
      <meta property="og:image:height" content="256">
      <meta property="og:image" content="https://other.test/second.png">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
    </head>`);
    expect(meta.imageUrl).toBe('https://good.test/primary.png');
    expect(meta.imageWidth).toBe(256);
    expect(meta.imageHeight).toBe(256);
  });

  it('drops the pair when the og:image is not the image being sent', () => {
    // ⚠ The image ladder falls through to `twitter:image`, and `og:image:width` describes
    // neither that nor the bare `<img src>` behind it. Pairing them anyway reserves a box of the
    // wrong shape for a differently-shaped picture — the exact mistake `pageRecord` already
    // carries a warning about on the oEmbed side.
    //
    // ⚠⚠ What holds this up is STRUCTURAL, not a guard: the pair is only ever recorded as a
    // sub-property of an `og:image` tag, so with no such tag there is nothing to carry over. An
    // explicit `usedPrimaryImage` condition was written for it first and DELETED — the drill
    // showed this test passing with the condition gone, because `images.push` runs only for
    // truthy content and so a `primaryImage` that exists has already won the ladder. Reddened
    // instead by making the sub-property handler stash onto a synthetic entry, which is the
    // mutation the structural rule actually forbids.
    const meta = scrapeMeta(`<head>
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
      <meta name="twitter:image" content="https://e.test/tw.png">
    </head>`);
    expect(meta.imageUrl).toBe('https://e.test/tw.png');
    expect(meta.imageWidth).toBeUndefined();
    expect(meta.imageHeight).toBeUndefined();
  });

  it('treats a half-declared or nonsense shape as no shape at all', () => {
    // A width with no height yields no ratio, and reading the one number as a shape is how a logo
    // ends up in a band. `0` and `"large"` are the same answer.
    for (const tags of [
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      '<meta property="og:image:width" content="0"><meta property="og:image:height" content="0">',
      '<meta property="og:image:width" content="large"><meta property="og:image:height" content="x">',
    ]) {
      const meta = scrapeMeta(
        `<head><meta property="og:image" content="https://e.test/card.png">${tags}</head>`,
      );
      expect(meta.imageUrl).toBe('https://e.test/card.png');
      expect(meta.imageWidth).toBeUndefined();
      expect(meta.imageHeight).toBeUndefined();
    }
  });

  it('drops the pair when the image URL itself is discarded as blank', () => {
    // ⚠ `content="   "` is deleted by the entity-cleanup pass, so the ladder ends with no image —
    // and a surviving width would then describe a picture that is not being sent at all.
    const meta = scrapeMeta(`<head>
      <meta property="og:image" content="   ">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
    </head>`);
    expect(meta.imageUrl).toBeUndefined();
    expect(meta.imageWidth).toBeUndefined();
  });

  it('does not retain the document a value was sliced out of', () => {
    // ⚠⚠ A memory bug that only manifests once PR 4 caches these, where nobody would trace it
    // back here: a V8 slice holds its ENTIRE parent, so a 60-character image URL pinned the
    // whole 512 KB document it came from. `String(s)`, `${s}`, `s.slice(0)` and `s.normalize()`
    // all fail to fix it — only forcing a cons-then-flatten does.
    //
    // ⚠ Retention is not observable from JS semantics, so this measures the heap, and it only
    // means anything when GC can be forced. Under a plain `npm test` the assertion is skipped
    // rather than faked — a test that cannot see the bug should say so instead of passing. To
    // run it for real: `node --expose-gc ./node_modules/.bin/vitest run linkMeta`.
    const gc = (globalThis as { gc?: () => void }).gc;

    const scrapeOne = (i: number) => {
      const pad = 'x'.repeat(512 * 1024);
      // A single-word site name has no whitespace to collapse, so it never took the accidental
      // escape route the multi-word text fields relied on — it needed the explicit detach as
      // much as the URL did.
      const meta = scrapeMeta(
        `<head><meta property="og:image" content="https://cdn.test/preview-${i}.png">` +
          `<meta property="og:site_name" content="GitHub"><!--${pad}--></head>`,
      );
      return meta;
    };

    // Correctness of the detach, which every run can check.
    const one = scrapeOne(0);
    expect(one.siteName).toBe('GitHub');
    expect(one.imageUrl).toBe('https://cdn.test/preview-0.png');

    if (!gc) return;

    gc();
    gc();
    const before = process.memoryUsage().heapUsed;
    const kept = Array.from({ length: 40 }, (_, i) => scrapeOne(i));
    gc();
    gc();
    const retainedMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

    expect(kept).toHaveLength(40);
    // 40 documents of 512 KB is 20 MB of parents. Detached, the cards are a few KB.
    expect(retainedMb).toBeLessThan(5);
  });
});

describe('decodeBody', () => {
  const cafe = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // café, latin1

  it('honours the charset the origin declared', () => {
    // ⚠ Regression guard. This took the raw `Content-Type` header and re-parsed it, which
    // could never match — every caller had only `RawResponse.contentType`, already stripped
    // to a bare `text/html`. The parameter is now the PARSED charset (`RawResponse.charset`).
    expect(decodeBody(cafe, 'iso-8859-1')).toBe('café');
    expect(decodeBody(cafe, 'windows-1252')).toBe('café');
  });

  it('IGNORES a value shaped like a header rather than half-reading it', () => {
    // ⚠⚠ The sharp edge of this PR's own change. `string | null` still accepts the old
    // `contentType` argument, and `'text/html'` is TRUTHY — so an un-updated caller would
    // short-circuit the in-document rescue below and be strictly WORSE off than before the
    // parameter changed. A charset name never contains '/' or ';', so a mis-shaped value is
    // treated as no declaration at all.
    const declaresItself = Buffer.concat([
      Buffer.from('<meta charset="windows-1252">', 'latin1'),
      Buffer.from([0xe9]),
    ]);
    expect(decodeBody(declaresItself, 'text/html')).toContain('é');
    expect(decodeBody(declaresItself, 'text/html; charset=iso-8859-1')).toContain('é');
    // Same answer as passing nothing, which is the point.
    expect(decodeBody(declaresItself, 'text/html')).toBe(decodeBody(declaresItself, null));
  });

  it('preserves the windows-1252 punctuation that latin1 destroys', () => {
    // ⚠ Regression guard, and the reason this decodes through TextDecoder. cp1252 puts the
    // smart quotes, dashes and ellipsis in 0x80-0x9F — exactly where latin1 has invisible C1
    // controls — so the approximation mangled the very characters it was chosen to preserve,
    // and `\s` doesn't match C1 so the whitespace collapse left them in the title.
    const bytes = Buffer.from([0x93, 0x48, 0x69, 0x94, 0x20, 0x97, 0x20, 0x92, 0x73]);
    expect(decodeBody(bytes, 'windows-1252')).toBe('“Hi” — ’s');
    expect(decodeBody(Buffer.from([0x80]), 'windows-1252')).toBe('€');
  });

  it('accepts the registry aliases, which used to be worse than saying nothing', () => {
    // ⚠ Each of these is a real registered label. Under the old three-name comparison they
    // matched nothing and fell through to UTF-8 — while still suppressing the in-document
    // rescue, so declaring a correct alias was strictly worse than declaring nothing.
    for (const alias of ['cp1252', 'iso8859-1', 'ISO-8859-1', 'latin1', 'us-ascii']) {
      expect(decodeBody(cafe, alias)).toBe('café');
    }
  });

  it('decodes the encodings that used to have no answer at all', () => {
    // windows-1251 (Cyrillic) and shift_jis were previously guessed as UTF-8 and rendered as
    // replacement characters. Node ships full ICU, so they simply work.
    expect(decodeBody(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), 'windows-1251')).toBe(
      'Привет',
    );
    expect(decodeBody(Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]), 'shift_jis')).toBe(
      'テスト',
    );
  });

  it('honours a charset declared in the document when the origin declared none', () => {
    const body = Buffer.concat([
      Buffer.from('<meta charset="windows-1252">', 'latin1'),
      Buffer.from([0xe9]),
    ]);
    expect(decodeBody(body, null)).toContain('é');
  });

  it('reads the http-equiv form of the declaration too', () => {
    const body = Buffer.concat([
      Buffer.from('<meta http-equiv="content-type" content="text/html; charset=iso-8859-1">'),
      Buffer.from([0xe9]),
    ]);
    expect(decodeBody(body, null)).toContain('é');
  });

  it('does not treat the TEXT "charset=" in a meta value as a declaration', () => {
    // ⚠ Regression guard. The probe was `/<meta[^>]+charset=["']?([\w-]+)/i`, which matched
    // that string ANYWHERE inside any <meta> tag — so a genuinely UTF-8 page describing how to
    // set a charset re-encoded its whole document and every accented character became mojibake.
    const body = Buffer.from(
      '<head><meta name="description" content="how to set charset=windows-1252 in HTML"></head><p>café</p>',
      'utf8',
    );
    expect(decodeBody(body, null)).toContain('café');
    // Same shape as the `data-content` bug this module already fixes, in a second scanner.
    const dataAttr = Buffer.from('<head><meta data-charset="gb2312" name="x"></head><p>café</p>');
    expect(decodeBody(dataAttr, null)).toContain('café');
  });

  it('defaults to UTF-8', () => {
    expect(decodeBody(Buffer.from('café', 'utf8'), null)).toBe('café');
  });

  it('falls back to UTF-8 for a label no decoder knows', () => {
    // TextDecoder throws on an unregistered label rather than decoding badly; that must not
    // escape as an exception on a best-effort path.
    expect(decodeBody(Buffer.from('café', 'utf8'), 'not-a-real-charset')).toBe('café');
  });

  it('lets the origin win over the document declaration', () => {
    // ⚠⚠ This test used to be a TAUTOLOGY: its fixture was pure ASCII, so the two branches
    // returned byte-identical output and the assertion could not fail — inverting the
    // precedence to `fromMeta || declared` left it green. The trailing non-ASCII byte is what
    // makes it real. A document copied between encodings keeps a stale <meta charset>; the
    // header describes the bytes actually on the wire.
    const body = Buffer.concat([
      Buffer.from('<meta charset="utf-8">', 'latin1'),
      Buffer.from([0xe9]),
    ]);
    expect(decodeBody(body, 'iso-8859-1')).toContain('é');
    expect(decodeBody(body, null)).toContain('�');
  });
});

describe('readOEmbed', () => {
  it('reads the structured fields', () => {
    const meta = readOEmbed({
      type: 'video',
      title: 'A Video',
      author_name: 'Someone',
      provider_name: 'YouTube',
      thumbnail_url: 'https://i.test/t.jpg',
      thumbnail_width: 480,
      thumbnail_height: 360,
    });
    expect(meta).toMatchObject({
      type: 'video',
      title: 'A Video',
      authorName: 'Someone',
      providerName: 'YouTube',
      thumbnailUrl: 'https://i.test/t.jpg',
      thumbnailWidth: 480,
      thumbnailHeight: 360,
    });
  });

  it('replaces a lone surrogate rather than passing it on', () => {
    // ⚠⚠ Regression guard. `decodeEntities` refuses surrogate ESCAPES, so the HTML path is
    // covered — but oEmbed arrives via `JSON.parse`, and `JSON.parse('"\\ud83d"')` yields a lone
    // U+D83D with no entity anywhere in it. That does not survive the SQLite round trip: it
    // comes back U+FFFD, so the requester who resolved a title and everyone served it from the
    // cache afterwards get different strings for one page — the exact divergence the clamp fix
    // is named for, reached through a door clamping cannot see. YouTube and Vimeo titles are
    // the ones that come through here.
    const meta = readOEmbed(JSON.parse('{"title":"ok\\ud83d","author_name":"\\udc4dsomebody"}'));
    const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lonely.test(meta?.title ?? '')).toBe(false);
    expect(lonely.test(meta?.authorName ?? '')).toBe(false);
    expect(meta?.title).toBe('ok\uFFFD');
  });

  it('never surfaces the provider html field', () => {
    // The whole point: oEmbed hands back a ready-made iframe and we refuse it.
    const meta = readOEmbed({ type: 'video', html: '<iframe src="https://evil.test"></iframe>' });
    expect(JSON.stringify(meta)).not.toContain('iframe');
  });

  it('rejects non-object input', () => {
    expect(readOEmbed(null)).toBeNull();
    expect(readOEmbed('a string')).toBeNull();
    // An array is typeof 'object', and every field would read as undefined off it.
    expect(readOEmbed([{ title: 'x' }])).toBeNull();
  });

  it('decodes entities, like the scraper does at its own boundary', () => {
    // ⚠ Regression guard. This was the ONE metadata path with no decodeEntities call — and it
    // is the path built specifically for YouTube, whose oEmbed endpoint HTML-escapes `title`
    // and `author_name`. `Rock &amp; Roll` reached the card verbatim: exactly the
    // `Tom &amp; Jerry` failure decodeEntities exists to prevent, on the provider the whole
    // oEmbed detour was built for.
    const meta = readOEmbed({ title: 'Rock &amp; Roll', author_name: 'Caf&eacute; Records' });
    expect(meta?.title).toBe('Rock & Roll');
    expect(meta?.authorName).toBe('Café Records');
  });

  it('ignores fields of the wrong type or nonsensical value', () => {
    const meta = readOEmbed({ title: 42, thumbnail_width: -1, author_name: '   ' });
    expect(meta?.title).toBeUndefined();
    expect(meta?.thumbnailWidth).toBeUndefined();
    expect(meta?.authorName).toBeUndefined();
  });
});
