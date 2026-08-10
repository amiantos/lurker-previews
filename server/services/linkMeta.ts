// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Pulling preview metadata out of an HTML document, and out of an oEmbed reply.
//
// Deliberately NOT a DOM parser. The Lounge pulls in cheerio for this; we need
// four tags out of `<head>` on a document we've already truncated to
// MAX_SCRAPE_BYTES, and a focused scanner is a fraction of the code, has no
// dependency to track CVEs on, and can't be induced to build a tree out of
// something hostile. The cost is that we'd miss metadata that only exists after
// JavaScript runs — but so does every other unfurler, Slack and Discord
// included, so a site that renders og: tags client-side simply doesn't get a
// card anywhere.
//
// ⚠ "Not a DOM parser" is not a licence to pattern-match. The scanner below is a
// real tokenizer — it tracks quoting, skips comments and script content, and
// ends the head by HTML5's own rule — because every shortcut short of that
// turned out to be a defect: a quadratic freeze on unterminated tags, a `>`
// inside an attribute value silently dropping the tag, one attribute's value
// impersonating another's, and a commented-out `<meta>` beating the real one.
// Each is documented at the code that fixes it.
//
// Pure and synchronous: bytes in, a plain object out. All the network lives in
// linkFetch.ts, which makes this the easy half to test exhaustively.

/** Raw metadata as found in a document. Any field may be absent. */
export interface ScrapedMeta {
  title?: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  /**
   * `og:image:width` / `og:image:height`, when the page declares them for the image that WON.
   *
   * ⚠ They decide the card's SHAPE, so a wrong pair is worse than no pair — see the assign site
   * for why they are dropped whenever `imageUrl` came from anywhere but the primary og:image.
   */
  imageWidth?: number;
  imageHeight?: number;
  // ⚠ No `ogType`. It was scraped, and documented as driving rendering, and read by nobody on
  // any branch — what actually decides a video card is the provider table in linkEmbed.ts,
  // because `og:type: video.other` on a site we have no embed URL for still renders as a page.
  // A field carried through three PRs on the strength of its own comment is worse than absent.
  /** Discovered `<link rel=alternate type=application/json+oembed>` endpoint. */
  oembedUrl?: string;
}

/** The subset of an oEmbed reply we're willing to act on. */
export interface OEmbedMeta {
  type?: string;
  title?: string;
  authorName?: string;
  providerName?: string;
  thumbnailUrl?: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
}

/** One start tag, with its attributes resolved. */
interface Tag {
  name: string;
  attrs: Map<string, string>;
  /** Raw text content, for `<title>` only. Undecoded. */
  text?: string;
}

/**
 * Index of `</name`, case-insensitively, without lowercasing the document.
 *
 * ⚠ `html.toLowerCase().indexOf(...)` would allocate a full copy of the document on every
 * call — and this is called once per opaque element, so a page with fifty `<script>` tags
 * would rebuild 512 KB fifty times. That is the same quadratic this scanner exists to remove,
 * reintroduced by the fix for it.
 */
function findClose(html: string, name: string, from: number): number {
  for (let at = from; ;) {
    at = html.indexOf('</', at);
    if (at === -1) return -1;
    const start = at + 2;
    if (html.slice(start, start + name.length).toLowerCase() === name) {
      const after = html[start + name.length];
      if (after === undefined || after === '>' || /\s/.test(after) || after === '/') return at;
    }
    at = start;
  }
}

/**
 * Elements HTML5 permits inside `<head>`.
 *
 * ⚠⚠ This list is what ENDS the head, and it has to be a positive list rather than a search
 * for `<body>`, because **`<body>` is optional in HTML5** — as is `</head>` — and a great many
 * real pages omit both. Scanning for the tag meant that on any such page the entire document
 * counted as head, so a `<meta property="og:title">` sitting in ordinary page content won the
 * card. On a forum, wiki or paste site that echoes user markup, that lets a commenter set the
 * preview title and image for every channel the link is pasted into.
 *
 * The spec's own rule is the cheap one: the head ends at the first element that isn't allowed
 * in it. `<p>` ends the head whether or not anyone wrote `<body>`.
 */
const HEAD_ELEMENTS = new Set([
  'base',
  'basefont',
  'bgsound',
  'link',
  'meta',
  'noframes',
  'noscript',
  'script',
  'style',
  'template',
  'title',
]);

/**
 * Elements whose content is not markup, and must be skipped wholesale.
 *
 * `<script>var s = "<body>";</script>` is the motivating case in both directions: a naive scan
 * reads that string as a real tag and truncates the head, and an inline `<svg><title>icon</title>`
 * shadows the document title. Skipping to the matching close tag settles both.
 */
const OPAQUE_ELEMENTS = new Set(['script', 'style', 'template', 'svg', 'math']);

/**
 * Walk a document's head, yielding start tags with their attributes parsed.
 *
 * ⚠⚠ Hand-written rather than regex-driven, and the reason is a measured DoS, not taste. The
 * scanners this replaces were `/<meta\b[^>]*>/gi` and friends: with no closing `>` in the
 * input, `[^>]*` rescans to end-of-string from every start position, which is quadratic.
 * Measured through the real `scrapeMeta` at the real 512 KB `MAX_SCRAPE_BYTES`, on a body of
 * `'<meta '.repeat(87381)`: **15.1 seconds inside one synchronous call**, doubling cleanly with
 * input size (32 KB = 66 ms, 512 KB = 15 s). The server is a single process with no yield point
 * in this path, so one pasted link stalls every user's IRC socket, ping timer and WS frame for
 * as long as it runs — and re-pasting re-triggers it. The origin is attacker-controlled, so it
 * costs nothing to serve. This scan is linear: the same input now completes in under a
 * millisecond.
 *
 * It also fixes two silent-wrong-answer bugs the regexes couldn't express:
 *
 *   - `>` is legal, unescaped, inside a quoted attribute value. `[^>]*>` cut the tag there and
 *     the truncated remainder matched no attribute, so `content="Settings > Privacy"` didn't
 *     truncate the title — it dropped the whole tag. Breadcrumbs and `=>` in a description are
 *     routine.
 *   - Attributes are read positionally now, so a value can no longer be mistaken for one.
 *     The old `attr()` searched the whole tag for `name=`, first match wins, which meant text
 *     inside an EARLIER attribute's value shadowed the real attribute. Verified on this branch:
 *     `<link rel="alternate" title="pick href=http://169.254.169.254/latest/meta-data/"
 *     type="application/json+oembed" href="https://real.test/oembed">` yielded the metadata
 *     endpoint as `oembedUrl` — the page choosing where the SERVER sends its next request.
 *     ipGuard refuses that address downstream, so it was never a live SSRF, but target
 *     selection is not something a scraped page gets to do. The `(?:^|[\s"'])` boundary that
 *     shipped as the fix for `data-content` did not close this: a space inside any preceding
 *     value satisfies it.
 */
function* scanHead(html: string): Generator<Tag> {
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return;
    i = lt + 1;

    // Comments, doctypes and processing instructions carry no metadata, and a `<meta>` left
    // commented out in production markup must not win the first-wins race against the real one.
    if (html.startsWith('!--', i)) {
      const end = html.indexOf('-->', i + 3);
      if (end === -1) return;
      i = end + 3;
      continue;
    }
    if (html[i] === '!' || html[i] === '?') {
      const end = html.indexOf('>', i);
      if (end === -1) return;
      i = end + 1;
      continue;
    }

    const closing = html[i] === '/';
    if (closing) i++;

    const nameStart = i;
    while (i < n && !/[\s/>]/.test(html[i])) i++;
    const name = html.slice(nameStart, i).toLowerCase();
    if (!name) continue;

    // `</head>` ends the head explicitly; every other close tag is uninteresting here.
    if (closing) {
      if (name === 'head') return;
      continue;
    }

    const attrs = new Map<string, string>();
    // Attribute loop. Positional, quote-aware, and it consumes the `>` that ends the tag —
    // which is what makes a `>` inside a value harmless.
    for (;;) {
      while (i < n && /\s/.test(html[i])) i++;
      if (i >= n) break;
      if (html[i] === '>') {
        i++;
        break;
      }
      if (html[i] === '/') {
        i++;
        continue;
      }

      const attrStart = i;
      while (i < n && !/[\s=/>]/.test(html[i])) i++;
      const attrName = html.slice(attrStart, i).toLowerCase();
      if (!attrName) {
        i++;
        continue;
      }

      while (i < n && /\s/.test(html[i])) i++;
      if (html[i] !== '=') {
        // A bare attribute (`<script defer>`). Present, with no value.
        if (!attrs.has(attrName)) attrs.set(attrName, '');
        continue;
      }
      i++;
      while (i < n && /\s/.test(html[i])) i++;

      let value: string;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        i++;
        const end = html.indexOf(quote, i);
        if (end === -1) {
          value = html.slice(i);
          i = n;
        } else {
          value = html.slice(i, end);
          i = end + 1;
        }
      } else {
        const start = i;
        while (i < n && !/[\s>]/.test(html[i])) i++;
        value = html.slice(start, i);
      }
      // First occurrence wins, matching how browsers treat a duplicated attribute.
      if (!attrs.has(attrName)) attrs.set(attrName, value);
    }

    // `<title>` is the one element here we want the TEXT of, not just the attributes.
    if (name === 'title') {
      const close = findClose(html, 'title', i);
      yield { name, attrs, text: html.slice(i, close === -1 ? n : close) };
      if (close === -1) return;
      i = close;
      continue;
    }

    if (OPAQUE_ELEMENTS.has(name)) {
      const close = findClose(html, name, i);
      // An unclosed <script> swallows the rest of the document — which is exactly what a
      // browser does with one, so there is nothing left to scrape either way.
      if (close === -1) return;
      i = close;
      continue;
    }

    // `html` and `head` are the wrappers themselves, not content.
    if (name !== 'html' && name !== 'head' && !HEAD_ELEMENTS.has(name)) return;
    yield { name, attrs };
  }
}

/**
 * The named entities that actually turn up in preview metadata.
 *
 * ⚠⚠ `Object.create(null)`, not an object literal. As a plain object the lookup below walked
 * `Object.prototype`, and `?? match` accepts what it finds there, because a function is neither
 * null nor undefined — so `decodeEntities('Rock &constructor; Roll')` returned
 * `'Rock function Object() { [native code] } Roll'`. Through the real scraper that put native
 * code source text into an `og:image` URL the server then resolves and fetches, and into a card
 * broadcast to every client in the channel. `constructor` is the only Object.prototype key that
 * survives the `[a-z]+` match, which made this one attacker-chosen name away rather than a live
 * bug.
 *
 * ⚠ The accented half is not garnish. This function exists because an undecoded entity renders
 * literally in the card — and a punctuation-only table left `Caf&eacute; M&uuml;ller` doing
 * exactly that on every French, German, Spanish and Nordic page, which is the defect it was
 * written to prevent. Anything rarer than this stays literal, which is the honest failure mode.
 *
 * ⚠ Case is significant: `&Eacute;` and `&eacute;` are different characters, so the lookup
 * tries the exact name before folding case.
 */
const NAMED_ENTITIES: Record<string, string> = Object.assign(Object.create(null), {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  sbquo: '‚',
  bdquo: '„',
  lsaquo: '‹',
  rsaquo: '›',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  dagger: '†',
  Dagger: '‡',
  prime: '′',
  Prime: '″',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  micro: 'µ',
  para: '¶',
  sect: '§',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  curren: '¤',
  iexcl: '¡',
  iquest: '¿',
  szlig: 'ß',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  atilde: 'ã',
  auml: 'ä',
  aring: 'å',
  aelig: 'æ',
  ccedil: 'ç',
  egrave: 'è',
  eacute: 'é',
  ecirc: 'ê',
  euml: 'ë',
  igrave: 'ì',
  iacute: 'í',
  icirc: 'î',
  iuml: 'ï',
  eth: 'ð',
  ntilde: 'ñ',
  ograve: 'ò',
  oacute: 'ó',
  ocirc: 'ô',
  otilde: 'õ',
  ouml: 'ö',
  oslash: 'ø',
  ugrave: 'ù',
  uacute: 'ú',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  thorn: 'þ',
  yuml: 'ÿ',
  Agrave: 'À',
  Aacute: 'Á',
  Acirc: 'Â',
  Atilde: 'Ã',
  Auml: 'Ä',
  Aring: 'Å',
  AElig: 'Æ',
  Ccedil: 'Ç',
  Egrave: 'È',
  Eacute: 'É',
  Ecirc: 'Ê',
  Euml: 'Ë',
  Igrave: 'Ì',
  Iacute: 'Í',
  Icirc: 'Î',
  Iuml: 'Ï',
  ETH: 'Ð',
  Ntilde: 'Ñ',
  Ograve: 'Ò',
  Oacute: 'Ó',
  Ocirc: 'Ô',
  Otilde: 'Õ',
  Ouml: 'Ö',
  Oslash: 'Ø',
  Ugrave: 'Ù',
  Uacute: 'Ú',
  Ucirc: 'Û',
  Uuml: 'Ü',
  Yacute: 'Ý',
  THORN: 'Þ',
});

/**
 * Decode the HTML entities that actually turn up in metadata.
 *
 * `og:description` is a string sitting inside an HTML attribute, so it arrives
 * escaped — an undecoded one renders as `Tom &amp; Jerry` in the card. halloy
 * has a whole `description_decode_html` config knob because some sites
 * double-escape; we decode once, unconditionally, which is right for the
 * overwhelming majority and leaves a `&amp;amp;` site looking slightly wrong
 * rather than making everyone else's apostrophes look broken.
 */
export function decodeEntities(text: string): string {
  // ⚠ The hex and decimal forms are separate alternatives on purpose. A combined
  // `#x?[0-9a-f]+` let the DECIMAL branch match hex letters, and `parseInt(body, 10)` then
  // prefix-parsed what it was handed: `&#99f;` decoded to `c` and `&#65a;` to `A`, where the
  // docblock and the "leaves malformed references alone" test both say they stay literal.
  // Splitting the alternatives means a malformed reference matches nothing at all.
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // Surrogates and out-of-range values would throw; leave them literal.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      // ⚠⚠ Control characters are refused, and this is the one place in Lurker where that
      // matters most: a preview title is among the very few strings in the app sourced from an
      // arbitrary third party rather than from an IRC server. Minting them let a scraped page
      // put **mIRC formatting codes into the message list** — U+0003 is colour, U+0002 is bold,
      // and Lurker's own renderer parses them — and a NUL into a SQLite TEXT column, where
      // C-string consumers truncate. The whitespace collapse downstream removes none of these:
      // `\s` does not match U+0000-U+0008 or the C1 range.
      if (isControl(code)) return match;
      return String.fromCodePoint(code);
    }
    // Case-sensitive first: `&Eacute;` and `&eacute;` are different characters. The fold is a
    // fallback for the punctuation names, which sites do write in mixed case.
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** C0 and C1 controls, less the three whitespace characters that are legitimate in text. */
function isControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/**
 * A charset NAME, as opposed to a header, a MIME type, or anything else a caller might
 * mistakenly hand over.
 *
 * ⚠⚠ This guard is the whole reason this PR exists, made structural instead of advisory.
 * `decodeBody` used to take a raw `Content-Type` and re-parse it, which could never match
 * anything — every caller had only `RawResponse.contentType`, already stripped to a bare
 * `text/html`. Taking the parsed charset instead fixes that, but a `string | null` parameter
 * still silently accepts the old argument, and passing `'text/html'` is worse than the
 * original bug rather than merely no better: it is TRUTHY, so it short-circuits the
 * in-document `<meta charset>` rescue that used to carry those pages. Verified — a
 * windows-1252 page declaring its charset in-document, served as bare `text/html`, decoded
 * correctly before this change and as replacement characters after it.
 *
 * A real charset label is a token: letters, digits, and `-._:` (per the WHATWG registry). A
 * MIME type or a header always carries `/` or `;`, so anything shaped wrong is treated as no
 * declaration at all and the document gets to speak for itself.
 */
const CHARSET_NAME = /^[a-z0-9][a-z0-9\-._:]*$/i;

/**
 * Decode bytes to text using the document's declared charset.
 *
 * A surprising amount of the long tail is still windows-1252, and reading it as UTF-8 turns
 * every smart quote into a replacement character right in the title.
 *
 * ⚠ Decoded through `TextDecoder`, not `Buffer.toString('latin1')`. The latin1 approximation
 * was not merely incomplete, it destroyed **precisely the characters it was chosen to
 * preserve**: windows-1252 puts the smart quotes, the dashes, the ellipsis and the euro sign
 * in 0x80-0x9F, which is exactly where latin1 has invisible C1 controls. Verified — the cp1252
 * bytes for `“Hi” — ’s` came back as `Hi  s`, and since `\s` does not
 * match C1, the whitespace collapse left those controls in a title bound for the database and
 * every client. The old comment claimed latin1 was "close enough for the punctuation that
 * matters here"; it was inverted.
 *
 * The node runtime image ships full ICU (not a small-icu build), so `TextDecoder` handles
 * every registry alias
 * (`cp1252`, `iso8859-1`, `us-ascii`) and the encodings the old triple had no answer for at
 * all — windows-1251, shift_jis, gbk, euc-kr. Each of those used to fall through to UTF-8;
 * worse, a *recognised* alias was strictly worse than sending nothing, because a non-matching
 * name still suppressed the in-document rescue.
 *
 * `fatal: false` is deliberate: a byte that isn't valid in the declared encoding becomes
 * U+FFFD, exactly as a browser renders it. A preview is best-effort and a partly-mojibake
 * title still beats no card.
 *
 * ⚠ `declared` is the charset the ORIGIN sent, already parsed out of its `Content-Type` —
 * `RawResponse.charset` in linkFetch. See `CHARSET_NAME` above for why that is enforced here
 * rather than trusted.
 */
export function decodeBody(body: Buffer, declared: string | null): string {
  const fromHeader = declared && CHARSET_NAME.test(declared) ? declared : null;

  // Read a prefix as ASCII to find an in-document declaration. Any charset we care about is
  // ASCII-compatible in its first bytes, so this is safe. Only consulted when the origin
  // didn't say — the header describes the bytes actually on the wire, and a document copied
  // between encodings routinely carries a stale <meta charset>.
  const charset = fromHeader ?? metaCharset(body.subarray(0, 2048).toString('latin1')) ?? 'utf-8';

  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    // An unregistered label. TextDecoder throws on construction rather than decoding badly,
    // which is the failure we want: fall back to the guess that is right for essentially
    // everything written this century.
    return body.toString('utf8');
  }
}

/**
 * The charset a document declares about itself, from the two forms HTML allows.
 *
 * ⚠ Read off parsed tags rather than by scanning for the text `charset=`. The old regex was
 * `/<meta[^>]+charset=["']?([\w-]+)/i`, which matched that string anywhere inside any `<meta>`
 * tag — so a genuinely UTF-8 page whose head contained
 * `<meta name="description" content="how to set charset=windows-1252 in HTML">` re-encoded its
 * entire document, and `café` came back as `cafÃ©`. Any page quoting a Content-Type, or any
 * blog post about encodings, triggered it. `data-charset="gb2312"` matched too — the same
 * `data-` prefix bug that this module already ships a fix for, in a second scanner fifteen
 * lines above the first.
 */
function metaCharset(probe: string): string | null {
  for (const tag of scanHead(probe)) {
    if (tag.name !== 'meta') continue;
    const direct = tag.attrs.get('charset');
    if (direct && CHARSET_NAME.test(direct)) return direct;
    if ((tag.attrs.get('http-equiv') || '').toLowerCase() === 'content-type') {
      const found = /;\s*charset\s*=\s*"?([^"';\s]+)/i.exec(tag.attrs.get('content') || '')?.[1];
      if (found && CHARSET_NAME.test(found)) return found;
    }
  }
  return null;
}

/**
 * Return a copy that does not retain the document it was sliced out of.
 *
 * ⚠⚠ Not a no-op, however much it looks like one. Slicing a string in V8 yields a SlicedString
 * that holds a pointer to its **entire parent**, so a 60-character image URL scraped out of a
 * page keeps all 512 KB of that page alive for as long as the URL is reachable — and PR 4
 * caches these, so a few hundred cards would pin a few hundred megabytes of other people's
 * HTML. It never presents as a leak: a heap snapshot shows a handful of short strings.
 *
 * Measured, 60 documents of 512 KB with every document dropped and `global.gc()` forced:
 *
 *     raw slice                       30.0 MB retained
 *     String(s) / `${s}` / s.slice(0) 30.0 MB retained   <- the obvious idioms do NOT work
 *     s.normalize()                   29.6 MB retained
 *     (' ' + s).slice(1)               0.5 MB retained
 *
 * Concatenating forces a ConsString, and slicing that forces V8 to flatten it into fresh
 * character storage; the parent is then unreferenced. `split('').join('')` and a Buffer round
 * trip also work and are slower.
 *
 * Applied to every field, not just the URLs — a text field escapes only when the whitespace
 * collapse actually rewrites it, so a single-word `og:site_name` like `GitHub` retains a
 * document while a two-word one does not.
 */
function detach(s: string): string {
  return s.length === 0 ? s : (' ' + s).slice(1);
}

/**
 * Scan a document's head for preview metadata.
 *
 * Precedence within each field is Open Graph → Twitter Card → plain HTML, which
 * is the order of decreasing intentionality: `og:title` was written to be a
 * preview title, `<title>` was written to be a browser tab. Note this differs
 * from Slack, which takes whichever of OG and Twitter appears *first* in the
 * document; a fixed precedence is easier to reason about and to test, and the
 * two disagree only on pages that set both to different values, which is a
 * mistake on the page's part either way.
 */
export function scrapeMeta(html: string): ScrapedMeta {
  const out: ScrapedMeta = {};

  const og = new Map<string, string>();
  const twitter = new Map<string, string>();
  /** og:image and its sub-properties, in document order — see the secure_url note below. */
  const images: { url: string; secureUrl?: string; width?: string; height?: string }[] = [];
  let titleText: string | undefined;
  let imageSrc: string | undefined;

  for (const tag of scanHead(html)) {
    if (tag.name === 'title') {
      titleText ??= tag.text;
      continue;
    }

    if (tag.name === 'meta') {
      const content = tag.attrs.get('content');
      if (!content) continue;
      // OG uses `property`, Twitter Card uses `name`, and plenty of sites use the
      // wrong one for both — so read either and route by the key's prefix.
      const key = (tag.attrs.get('property') || tag.attrs.get('name') || '').toLowerCase();
      if (!key) continue;

      // ⚠ `og:image:secure_url` is a sub-property of the og:image that PRECEDES it, not a
      // document-level field. Read flat and preferred outright, it silently defeated the
      // "first og:image wins" rule two lines down: a CMS emitting a hero image followed by
      // per-article images, each with its own secure_url, had the LAST image's https variant
      // beat the site's designated primary. Tracking them in order keeps both rules true.
      if (key === 'og:image') {
        images.push({ url: content });
        continue;
      }
      if (key === 'og:image:secure_url') {
        if (images.length > 0) images[images.length - 1].secureUrl = content;
        continue;
      }
      // ⚠ Sub-properties of the PRECEDING og:image, exactly like secure_url above, and tracked
      // per-image for the same reason: a CMS emitting a hero image followed by per-article ones
      // declares a width for each, and read flat the last one would describe the first one's
      // picture. That mistake is invisible in a URL and loud in a layout — it decides whether
      // the card renders a hero band or a 72px square.
      if (key === 'og:image:width' || key === 'og:image:height') {
        if (images.length > 0) {
          const at = images[images.length - 1];
          if (key === 'og:image:width') at.width ??= content;
          else at.height ??= content;
        }
        continue;
      }

      if (key.startsWith('og:')) {
        if (!og.has(key)) og.set(key, content); // first wins: og: properties repeat
      } else if (key.startsWith('twitter:')) {
        if (!twitter.has(key)) twitter.set(key, content);
      } else if (key === 'description' && !twitter.has('description')) {
        twitter.set('description', content);
      }
      continue;
    }

    if (tag.name === 'link') {
      // `rel` is a space-separated token list, so `rel="alternate canonical"` is one tag with
      // two tokens — and `includes` was a substring test, which accepted `notalternateatall`.
      const rel = new Set((tag.attrs.get('rel') || '').toLowerCase().split(/\s+/));
      const type = (tag.attrs.get('type') || '').toLowerCase();
      const href = tag.attrs.get('href');
      if (!href) continue;
      // ⚠ No `break` here. The loop used to stop at the first oEmbed-typed tag, which made the
      // card depend on tag ORDER: the same document with its <link>s swapped produced a
      // different result, and an oEmbed tag carrying no href stopped the scan on behalf of a
      // valid one further down.
      if (!out.oembedUrl && rel.has('alternate') && type === 'application/json+oembed') {
        out.oembedUrl = href;
      } else if (!imageSrc && rel.has('image_src')) {
        imageSrc = href;
      }
    }
  }

  const primaryImage = images[0];
  // ⚠ Assigned only when found. These used to be written unconditionally, so the result
  // always carried five keys — `'imageUrl' in meta` was true for a document with no metadata
  // at all, and `{...oembedValues, ...scrapeMeta(html)}` evaluated to all-undefined, silently
  // destroying every oEmbed field it was meant to fall back to.
  // ⚠ Keyed on the STRING members only, derived rather than listed. `ScrapedMeta` gained numeric
  // `imageWidth`/`imageHeight`, and a plain `keyof` then let this helper be called with a key
  // whose value is a number — which typechecks as a widened union and writes a string into it.
  // Deriving the set means adding another numeric field cannot quietly re-open that.
  type StringMetaKey = {
    [K in keyof ScrapedMeta]-?: ScrapedMeta[K] extends string | undefined ? K : never;
  }[keyof ScrapedMeta];
  const assign = (k: StringMetaKey, v: string | undefined) => {
    if (v !== undefined && v !== '') out[k] = v;
  };

  assign('title', og.get('og:title') || twitter.get('twitter:title') || titleText);
  assign(
    'description',
    og.get('og:description') || twitter.get('twitter:description') || twitter.get('description'),
  );
  // ⚠ `og:site_name` only. `twitter:site` is a HANDLE (`@nytimes`), not a site name — it names
  // the account that owns the card, which is a different field wearing a similar key. Falling
  // back to it put an @-handle in the card's site slot on every page that sets one and no
  // `og:site_name`, which is a lot of them. With no site name the caller uses the hostname,
  // which is always accurate and never someone's username.
  assign('siteName', og.get('og:site_name'));
  assign(
    'imageUrl',
    primaryImage?.secureUrl ||
      primaryImage?.url ||
      twitter.get('twitter:image') ||
      twitter.get('twitter:image:src') ||
      imageSrc,
  );

  // Decode and tidy at the boundary, so callers never handle a raw entity. An empty result is
  // an ABSENT field, not a present empty string: `content="   "` used to survive as `''`, and
  // `new URL('', base)` resolves to the page itself — so the server fetched an HTML document
  // as if it were the preview image.
  for (const k of ['title', 'description', 'siteName'] as const) {
    const v = out[k];
    if (v === undefined) continue;
    const clean = detach(decodeEntities(v).replace(/\s+/g, ' ').trim());
    if (clean) out[k] = clean;
    else delete out[k];
  }
  for (const k of ['imageUrl', 'oembedUrl'] as const) {
    const v = out[k];
    if (v === undefined) continue;
    const clean = detach(decodeEntities(v).trim());
    if (clean) out[k] = clean;
    else delete out[k];
  }

  /**
   * The declared shape of the image, and ONLY when the primary og:image is the one being sent.
   *
   * ⚠⚠ Three gates, each of which was a wrong card shape waiting to happen:
   *
   *   1. `out.imageUrl` must have SURVIVED the cleanup above. A `content="  "` og:image is
   *      deleted there, and the ladder then has nothing — so a surviving width would describe
   *      an image that is not being sent.
   *   2. Both numbers must be present and sane. A page declaring only a width, or `0`, or
   *      `"large"`, yields no ratio — and a half-known shape must read as unknown rather than
   *      as a default, because the default is the hero and the thing it gets wrong is logos.
   *
   * ⚠⚠ A third gate belongs here on the face of it — "the primary og:image must be what WON",
   * since the ladder falls through to `twitter:image` and then a bare `<img src>`, and
   * `og:image:width` describes neither. It is NOT written, because it cannot fire: the pair is
   * only ever recorded as a sub-property of an `og:image` tag, and `images.push` runs only for
   * truthy content — so `primaryImage` existing at all means it won the ladder outright. It was
   * written first, and the test aiming at it passed with the condition deleted, which is how the
   * redundancy was found.
   *
   * ⚠ So the invariant is STRUCTURAL rather than guarded, and it breaks silently if the ladder is
   * ever reordered to prefer `twitter:image`. That reordering must add the gate back.
   */
  if (out.imageUrl !== undefined) {
    const w = Number(primaryImage?.width);
    const h = Number(primaryImage?.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      out.imageWidth = Math.round(w);
      out.imageHeight = Math.round(h);
    }
  }
  return out;
}

/**
 * Read the fields we trust out of an oEmbed reply.
 *
 * Note what is NOT read: `html`. oEmbed hands back a ready-made iframe, and
 * injecting a third party's markup into the message list is not a thing we are
 * going to do — it's an XSS vector wearing a standards badge. We take the
 * structured fields and build any embed ourselves from a provider table we
 * control (see linkEmbed.ts).
 */
/**
 * Replace unpaired surrogates with U+FFFD.
 *
 * ⚠ This is the JSON path's equivalent of the guard `decodeEntities` already applies to numeric
 * character references, and it is needed for the same reason at a different door:
 * `JSON.parse('"\\ud83d"')` yields a lone U+D83D directly, no entity involved. A lone surrogate
 * does not survive the SQLite round trip — it comes back as U+FFFD — so the requester who
 * resolved a title and everyone served it from the cache afterwards get measurably different
 * strings for one page, which is the divergence the clamp fix was named for, reached from an
 * input clamping cannot see. Doing it here means a caller never handles one, whichever producer
 * it came from.
 */
function stripLoneSurrogates(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

export function readOEmbed(json: unknown): OEmbedMeta | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  // ⚠ Decoded here, same as scrapeMeta decodes at its own boundary. This was the one metadata
  // path with no `decodeEntities` call — and it is the path built specifically for YouTube,
  // whose oEmbed endpoint HTML-escapes `title` and `author_name`. A video called `Rock & Roll`
  // arrived as `Rock &amp; Roll` and reached the card verbatim: precisely the `Tom &amp; Jerry`
  // failure decodeEntities exists to prevent, on the provider the whole oEmbed detour was
  // built for. Decoding in both places keeps the contract one thing — a caller never handles a
  // raw entity, whichever path produced the value.
  const str = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const clean = detach(stripLoneSurrogates(decodeEntities(v)).replace(/\s+/g, ' ').trim());
    return clean || undefined;
  };
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

  return {
    type: str(o.type),
    title: str(o.title),
    authorName: str(o.author_name),
    providerName: str(o.provider_name),
    thumbnailUrl: str(o.thumbnail_url),
    thumbnailWidth: num(o.thumbnail_width),
    thumbnailHeight: num(o.thumbnail_height),
  };
}
