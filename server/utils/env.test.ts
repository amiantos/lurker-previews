// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { envInt } from './env.js';

const env = (v?: string) => ({ KNOB: v }) as NodeJS.ProcessEnv;

afterEach(() => vi.restoreAllMocks());

describe('envInt', () => {
  it('reads a plain integer', () => {
    expect(envInt('KNOB', 5, { min: 1 }, env('42'))).toBe(42);
    expect(envInt('KNOB', 5, { min: 1 }, env(' 7 '))).toBe(7);
  });

  it('is the default when the knob is absent or blank, silently', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(envInt('KNOB', 5, { min: 1 }, env())).toBe(5);
    expect(envInt('KNOB', 5, { min: 1 }, env(''))).toBe(5);
    expect(err).not.toHaveBeenCalled();
  });

  it('refuses a typo loudly and keeps the default — never NaN, never a zero timer', () => {
    // ⚠ The shipped failure: `64MB` read as NaN turned the whole-file cap OFF; `5s` read as
    // NaN made every decode time out at once.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of ['64MB', '5s', 'NaN', 'Infinity', '1.5', '-3', '0', '1e3x']) {
      expect(envInt('KNOB', 5, { min: 1 }, env(bad))).toBe(5);
    }
    expect(err).toHaveBeenCalledTimes(8);
    expect(err.mock.calls[0][0]).toContain('KNOB');
  });

  it('honours the range', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(envInt('KNOB', 8030, { min: 1, max: 65535 }, env('70000'))).toBe(8030);
    expect(envInt('KNOB', 8030, { min: 1, max: 65535 }, env('65535'))).toBe(65535);
  });
});
