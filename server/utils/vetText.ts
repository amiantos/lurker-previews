// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Text an origin wrote, made safe to hand the cell.
//
// ⚠⚠ `decodeEntities` refuses a NUMERIC reference to a control character — `&#3;` stays
// literal — and its comment says why: U+0002/U+0003 are mIRC bold and colour, which the
// cell's renderer parses, and NUL truncates every C-string reader of the SQLite column.
// But the same bytes arrive two other ways and were not filtered: a literal 0x03 inside
// `content="…"` survives TextDecoder, the `\s+` collapse (which matches none of C0/C1)
// and the clamp; an oEmbed title of `"\u0003..."` passes JSON.parse untouched. The
// entity guard was the lock on one of three doors.
//
// Invisible format characters are the other half. A bidi override (U+202E) renders a
// title reversed; isolates and embeddings spoof the apparent text of a card the same way;
// a soft hyphen, a zero-width space or a word joiner is padding nobody can see. Those are
// stripped — by an EXPLICIT list, not `\p{Cf}`: the whole category also holds the emoji
// tag characters (the England flag is a black flag plus seven of them), the Arabic number
// signs and the Egyptian hieroglyph joiners, and ZWJ/ZWNJ (emoji sequences, Indic
// conjuncts) and the bidi MARKS (LRM/RLM/ALM, which nudge neutrals and cannot reorder
// text). Stripping the category altered real titles; the list names the spoofing
// characters and nothing else.
//
// Applied in ONE place, `clamp()` in resolve.ts, so every field the cell receives has
// been through it whichever producer wrote the value — and on refusal `reason` strings,
// which quote the caller's input.

/** C0 (less \t \n \r, which the whitespace collapse handles) + DEL + C1. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * The format characters that spoof or pad, and only those. Written as code points so the
 * file never holds an invisible character a formatter could rewrite:
 *   U+00AD soft hyphen · U+180E Mongolian vowel separator · U+200B zero-width space
 *   U+202A–U+202E bidi embeddings and overrides · U+2060–U+2064 word joiner, invisible
 *   operators · U+2066–U+2069 bidi isolates · U+FEFF zero-width no-break space (BOM)
 */
const INVISIBLE = new RegExp(
  `[${[[0x00ad], [0x180e], [0x200b], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff]]
    .map(([from, to]) =>
      to === undefined
        ? `\\u{${from.toString(16)}}`
        : `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`,
    )
    .join('')}]`,
  'gu',
);

export function vetText(text: string): string {
  // ⚠ NFC LAST: a format character stripped from between a base and its combining mark
  // leaves a sequence that was composed before the strip and is not after it.
  return text
    .replace(CONTROLS, '')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}
