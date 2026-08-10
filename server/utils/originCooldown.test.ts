// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import {
  cooldownCountForTests,
  cooldownRemaining,
  isTransientStatus,
  noteRefusal,
  resetCooldownsForTests,
} from './originCooldown.js';

// A fixed clock. `Date.now()` would make every boundary assertion a race.
const NOW = 1_700_000_000_000;

beforeEach(() => resetCooldownsForTests());

describe('isTransientStatus', () => {
  it('separates "not now" from "not ever"', () => {
    // ⚠⚠ The distinction the whole fix rests on. 404/403/410 are facts about a
    // URL and must keep reporting as permanent — retrying a hotlink-protected
    // image forever helps nobody, and an <img> that never re-asks is CORRECT
    // there. 429 and the 5xx family are the ones that change on their own.
    for (const s of [429, 500, 502, 503, 504]) {
      expect(`${s}: ${isTransientStatus(s)}`).toBe(`${s}: true`);
    }
    for (const s of [400, 401, 403, 404, 410, 418, 451]) {
      expect(`${s}: ${isTransientStatus(s)}`).toBe(`${s}: false`);
    }
  });
});

describe('cooldowns', () => {
  it('holds a host off, then lets it go once the window passes', () => {
    noteRefusal('example.com', { 'retry-after': '30' }, NOW);
    expect(cooldownRemaining('example.com', NOW)).toBe(30);
    expect(cooldownRemaining('example.com', NOW + 29_000)).toBe(1);
    expect(cooldownRemaining('example.com', NOW + 30_001)).toBe(0);
  });

  it('holds only the host that refused', () => {
    noteRefusal('example.com', {}, NOW);
    expect(cooldownRemaining('example.com', NOW)).toBeGreaterThan(0);
    expect(cooldownRemaining('other.example', NOW)).toBe(0);
  });

  it('prefers the host’s own instruction over a guess', () => {
    // ⚠ Both legal forms of Retry-After, then GitHub's actual flavour. Guessing
    // when the answer is sitting in the response is how a backoff ends up either
    // useless or far too long.
    noteRefusal('a.example', { 'retry-after': '45' }, NOW);
    expect(cooldownRemaining('a.example', NOW)).toBe(45);

    resetCooldownsForTests();
    noteRefusal('b.example', { 'retry-after': new Date(NOW + 90_000).toUTCString() }, NOW);
    expect(cooldownRemaining('b.example', NOW)).toBe(90);

    resetCooldownsForTests();
    // What `opengraph.githubassets.com` actually sends: an epoch SECOND.
    noteRefusal('c.example', { 'x-ratelimit-reset': String((NOW + 120_000) / 1000) }, NOW);
    expect(cooldownRemaining('c.example', NOW)).toBe(120);
  });

  it('falls back to a short guess when the host says nothing', () => {
    // ⚠ SHORT on purpose. A wrong guess that is too long blanks every image on
    // that host for the whole window, which is worse than one extra rejected
    // request — a host that means it will simply refuse again.
    noteRefusal('quiet.example', {}, NOW);
    expect(cooldownRemaining('quiet.example', NOW)).toBe(60);
  });

  it('refuses to be benched for a day by a hostile Retry-After', () => {
    // ⚠⚠ The value comes from a third party. Honouring it unbounded would let any
    // origin turn off previews for its own images — and for a shared host like
    // githubassets, for every repository at once — for as long as it likes.
    noteRefusal('hostile.example', { 'retry-after': '86400' }, NOW);
    expect(cooldownRemaining('hostile.example', NOW)).toBe(600);

    resetCooldownsForTests();
    noteRefusal('hostile.example', { 'x-ratelimit-reset': String((NOW + 86_400_000) / 1000) }, NOW);
    // Past the ceiling the header is not believed at all, and the default applies.
    expect(cooldownRemaining('hostile.example', NOW)).toBe(60);
  });

  it('ignores a reset time that has already passed', () => {
    // A stale or misread header must not produce a zero-or-negative window that
    // reads as "cool down for no time at all" and hides the refusal.
    noteRefusal('stale.example', { 'x-ratelimit-reset': String((NOW - 5000) / 1000) }, NOW);
    expect(cooldownRemaining('stale.example', NOW)).toBe(60);
  });

  it('sweeps expired entries instead of remembering every host that ever failed', () => {
    // ⚠⚠ `cooldownRemaining` deletes lazily and only for the host it is handed, so
    // a one-off refusal from a host nobody links again would sit in the map for the
    // life of the process — and these run for months. (Copilot.)
    for (let i = 0; i < 500; i++) {
      noteRefusal(`host-${i}.example`, { 'retry-after': '30' }, NOW);
    }
    expect(cooldownCountForTests()).toBe(500);

    // Nobody ever asks about those hosts again. A refusal from a DIFFERENT host,
    // after their windows lapse, is what collects them.
    noteRefusal('later.example', { 'retry-after': '30' }, NOW + 31_000);
    expect(cooldownCountForTests()).toBe(1);
  });

  it('keeps entries that have not expired yet', () => {
    // ⚠ The sweep must not be a `clear()` in disguise — a live hold on another host
    // is the whole point of the map, and dropping it would re-open the flood this
    // module exists to stop.
    noteRefusal('long.example', { 'retry-after': '300' }, NOW);
    noteRefusal('short.example', { 'retry-after': '10' }, NOW);
    noteRefusal('trigger.example', { 'retry-after': '30' }, NOW + 11_000);

    expect(cooldownRemaining('long.example', NOW + 11_000)).toBe(289);
    expect(cooldownRemaining('short.example', NOW + 11_000)).toBe(0);
    expect(cooldownCountForTests()).toBe(2);
  });

  it('takes a repeated refusal as the new deadline', () => {
    noteRefusal('example.com', { 'retry-after': '10' }, NOW);
    noteRefusal('example.com', { 'retry-after': '120' }, NOW);
    expect(cooldownRemaining('example.com', NOW)).toBe(120);
  });
});
