// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Remembering that a host told us to go away.
//
// ⚠⚠ Written from a real failure, not a hypothetical. `opengraph.githubassets.com`
// — the host every GitHub link's og:image lives on — enforces a budget of 100
// requests, advertised in `x-ratelimit-*`. A channel with a run of GitHub links
// spends that in one burst from a single instance IP, GitHub answers 429, and
// nothing here remembered it: every later view of every one of those images went
// out and asked again, so the budget could never recover and the images stayed
// blank.
//
// ⚠ The byte cache is what ultimately fixes this — one successful fetch serves
// every user of the instance forever — but the cache can only be populated by a
// SUCCESS. While a host is rate-limiting, the mechanism that would end the
// hammering is precisely the one that cannot engage. Something has to break that
// loop from outside, and this is it.
//
// ⚠ Deliberately NOT a per-host concurrency cap, which is what this looked like
// it needed at first glance. Concurrency is not rate: four in flight at half a
// second each is ~480/min, still far past a 100/min budget, so a cap would smooth
// the burst and still exhaust the limit on a sustained scroll. What actually
// protects a budget is not spending it — and 429 is the host telling us exactly
// when to stop.

/** Hosts we are holding off, and until when (epoch ms). */
const cooldowns = new Map<string, number>();

/**
 * How long to wait when the host does not say.
 *
 * ⚠ Short on purpose. This is a guess, and a wrong guess that is too long makes
 * every image on a host blank for that whole window — a worse outcome than one
 * extra rejected request. A host that means it will simply 429 again.
 */
const DEFAULT_COOLDOWN_MS = 60_000;

/** Ceiling on anything a host asks for. An origin sending `Retry-After: 86400`
 *  must not be able to disable previews for that host for a day. */
const MAX_COOLDOWN_MS = 10 * 60_000;

/**
 * Statuses that mean "not now" rather than "not ever".
 *
 * ⚠ 429 and 503 are the two that carry `Retry-After` by convention. The 5xx
 * neighbours are included because they are transient by definition; 4xx other
 * than 429 are NOT, and must keep reporting as a permanent failure — a 403 on a
 * hotlink-protected image is a fact about that URL, and retrying it forever
 * helps nobody.
 */
export function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Seconds until this host may be asked again, or 0 if it may be asked now. */
export function cooldownRemaining(host: string, now = Date.now()): number {
  const until = cooldowns.get(host);
  if (until === undefined) return 0;
  if (until <= now) {
    cooldowns.delete(host);
    return 0;
  }
  return Math.ceil((until - now) / 1000);
}

/**
 * Record that a host refused us, and for how long to believe it.
 *
 * ⚠ Reads the host's OWN instruction first — `Retry-After` in both its legal
 * forms (delta-seconds and an HTTP-date), then `x-ratelimit-reset`, which is what
 * `opengraph.githubassets.com` actually sends. Guessing when the answer is in the
 * response is how a backoff ends up either useless or far too long.
 */
export function noteRefusal(
  host: string,
  headers: Record<string, string | string[] | undefined>,
  now = Date.now(),
): void {
  // ⚠⚠ Expired entries are swept HERE, not only when their own host is asked
  // about again. `cooldownRemaining` deletes lazily and only for the host it was
  // handed, so a host that refuses once and is never linked again keeps its entry
  // for the life of the process — and these processes run for months. (Copilot.)
  //
  // ⚠ The sweep is what gives this a real bound rather than a smaller leak. Size
  // becomes proportional to refusals within one window instead of to every host
  // that has ever failed: `mediaThrottle` caps byte requests at 300/min and
  // MAX_COOLDOWN_MS is ten minutes, so the map cannot exceed a few thousand
  // entries however long the process lives or how hard anyone leans on it.
  //
  // ⚠ On refusal rather than on a timer, because refusals are the rare path — an
  // O(n) pass here costs microseconds and needs no interval to own, unref, or
  // remember to clear in tests.
  for (const [seen, until] of cooldowns) {
    if (until <= now) cooldowns.delete(seen);
  }
  const wait = retryAfterMs(headers, now) ?? DEFAULT_COOLDOWN_MS;
  cooldowns.set(host, now + Math.min(wait, MAX_COOLDOWN_MS));
}

function first(value: string | string[] | undefined): string {
  return String(Array.isArray(value) ? value[0] : (value ?? '')).trim();
}

function retryAfterMs(
  headers: Record<string, string | string[] | undefined>,
  now: number,
): number | null {
  const retryAfter = first(headers['retry-after']);
  if (retryAfter) {
    // delta-seconds
    if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
    // ...or an HTTP-date, which RFC 9110 allows and some CDNs prefer.
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  // GitHub's flavour: an epoch SECOND at which the budget refills.
  const reset = first(headers['x-ratelimit-reset']);
  if (/^\d+$/.test(reset)) {
    const at = Number(reset) * 1000;
    // ⚠ Sanity-checked rather than trusted. A header in the past, or absurdly far
    // ahead, means we are reading something that is not what we think it is.
    if (at > now && at - now < MAX_COOLDOWN_MS) return at - now;
  }
  return null;
}

// ⚠ There is deliberately NO `noteSuccess`. Clearing a hold when a request
// succeeds sounds obviously right and is not: a hold short-circuits the fetch, so
// nothing can succeed while one is armed EXCEPT in the concurrent burst this
// exists to damp — where a single success among two dozen refusals would tear
// down the hold the refusals just armed. Holds end on their own clock.

/** Test seam. */
export function resetCooldownsForTests(): void {
  cooldowns.clear();
}

/** Test seam: the sweep is invisible from the outside, since an expired entry and
 *  an absent one answer identically. */
export function cooldownCountForTests(): number {
  return cooldowns.size;
}
