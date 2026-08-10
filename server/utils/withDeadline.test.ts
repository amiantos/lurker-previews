// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { withDeadline, DeadlineExceeded } from './withDeadline.js';

const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe('withDeadline', () => {
  it('passes work that finishes in time straight through', async () => {
    expect(await withDeadline(after(5, 'done'), 500)).toBe('done');
  });

  it('rejects with a distinguishable error once the deadline lapses', async () => {
    // Distinguishable on purpose: running out of time says nothing about the work, so a caller
    // must be able to avoid recording it as a verdict.
    await expect(withDeadline(after(500, 'late'), 20, 'resolve')).rejects.toBeInstanceOf(
      DeadlineExceeded,
    );
  });

  it('lets the work’s own failure through rather than masking it', async () => {
    const boom = Promise.reject(new TypeError('the actual problem'));
    await expect(withDeadline(boom, 500)).rejects.toBeInstanceOf(TypeError);
  });
});
