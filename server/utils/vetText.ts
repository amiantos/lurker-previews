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
// Format characters are the other half. A bidi override (U+202E) renders a title
// reversed; isolates and embeddings spoof the apparent text of a card the same way; a
// soft hyphen or zero-width space is invisible padding. Stripped, except the handful that
// carry meaning in ordinary text: ZWNJ/ZWJ (emoji sequences, Indic conjuncts) and the
// bidi MARKS (LRM/RLM/ALM), which only nudge the direction of neutrals and cannot
// reorder what is displayed.
//
// Applied in ONE place, `clamp()` in resolve.ts, so every field the cell receives has
// been through it whichever producer wrote the value — and on refusal `reason` strings,
// which quote the caller's input.

/** C0 (less \t \n \r, which the whitespace collapse handles) + DEL + C1. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** The five format characters that carry text meaning: ZWNJ, ZWJ, LRM, RLM, ALM. Built from
 *  code points so the file never holds an invisible character a formatter could rewrite. */
const KEPT_FORMAT = new Set(
  [0x200c, 0x200d, 0x200e, 0x200f, 0x061c].map((c) => String.fromCodePoint(c)),
);

export function vetText(text: string): string {
  return text
    .normalize('NFC')
    .replace(CONTROLS, '')
    .replace(/\p{Cf}/gu, (ch) => (KEPT_FORMAT.has(ch) ? ch : ''))
    .replace(/\s+/g, ' ')
    .trim();
}
