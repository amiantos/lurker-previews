// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { vetText } from './vetText.js';

// ⚠ Every invisible character here is built from its code point. A formatter rewrites
// a Unicode escape inside a string literal as the character itself, which is invisible in a diff —
// exactly the property this file tests for, and no way to write a test about it.
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const [zwnj, zwj, lrm, rlm, alm] = [cp(0x200c), cp(0x200d), cp(0x200e), cp(0x200f), cp(0x061c)];

describe('vetText', () => {
  it('strips raw mIRC formatting bytes and NUL — the three doors the entity guard left open', () => {
    // ⚠ Verified against the old path first: `\s` matches none of these, so the whitespace
    // collapse alone leaves every one in place.
    const raw = `Hello${cp(0x03)},${cp(0x02)} world${cp(0x00)}!`;
    expect(raw.replace(/\s+/g, ' ')).toBe(raw);
    expect(vetText(raw)).toBe('Hello, world!');
  });

  it('strips DEL and the C1 range', () => {
    expect(vetText(`a${cp(0x7f)}b${cp(0x85)}c${cp(0x9f)}d`)).toBe('abcd');
  });

  it('strips bidi overrides, isolates and invisible padding', () => {
    const [rlo, pdf, lri, pdi] = [cp(0x202e), cp(0x202c), cp(0x2066), cp(0x2069)];
    const [shy, zwsp, bom] = [cp(0x00ad), cp(0x200b), cp(0xfeff)];
    expect(vetText(`${rlo}gnp.ecioinvi${pdf}`)).toBe('gnp.ecioinvi');
    expect(vetText(`a${lri}b${pdi}c`)).toBe('abc');
    expect(vetText(`soft${shy}hyphen zero${zwsp}width ${bom}bom`)).toBe('softhyphen zerowidth bom');
    expect(vetText(`a${cp(0x2060)}b${cp(0x2062)}c`)).toBe('abc');
  });

  it('keeps the format characters that carry meaning', () => {
    const family = `${cp(0x1f468)}${zwj}${cp(0x1f469)}${zwj}${cp(0x1f467)}`;
    expect(vetText(family)).toBe(family);
    const conjunct = `${cp(0x915)}${zwj}${cp(0x937)}`;
    expect(vetText(conjunct)).toBe(conjunct);
    const marks = `a${lrm}b${rlm}c${alm}d${zwnj}e`;
    expect(vetText(marks)).toBe(marks);
    // ⚠ The emoji TAG characters are format characters too: the England flag is U+1F3F4 plus
    // seven of them. `\p{Cf}` stripped them and shipped a plain black flag (code review).
    const england = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
    expect(vetText(england)).toBe(england);
    const arabicNumberSign = `${cp(0x600)}${cp(0x661)}`;
    expect(vetText(arabicNumberSign)).toBe(arabicNumberSign);
  });

  it('normalises to NFC and collapses whitespace', () => {
    expect(vetText(`e${cp(0x301)}`)).toBe(cp(0xe9));
    // ⚠ Normalised LAST: a strip between base and mark must still leave composed output.
    expect(vetText(`e${cp(0x200b)}${cp(0x301)}`)).toBe(cp(0xe9));
    expect(vetText('  two\t\n words  ')).toBe('two words');
  });

  it('leaves ordinary text alone', () => {
    const plain = 'Tom & Jerry — “quoted” 日本語 🎉';
    expect(vetText(plain)).toBe(plain);
  });
});
