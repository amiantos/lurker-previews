// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Numeric knobs from the environment, validated at boot.
//
// ⚠ `Number(process.env.X ?? default)` is how these were read, and a typo is the
// failure: `LURKER_PREVIEWS_POSTER_FULL_FETCH_BYTES=64MB` is NaN, `seen > NaN` is
// always false, and the whole-file cap is silently off — a 64 GB origin then fills
// tmpfs, which is RAM, until the memory limit kills the container. The timeout knob
// fails the other way: `5s` is a timer that fires at once and every poster is empty.
// A knob that cannot be parsed is logged and IGNORED; the default is the safe value.

export interface IntRange {
  min: number;
  max?: number;
}

/** A positive integer from `env[name]`, or `fallback` (logged) when it is absent or unusable. */
export function envInt(
  name: string,
  fallback: number,
  range: IntRange = { min: 1 },
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  const ok =
    Number.isSafeInteger(n) && n >= range.min && (range.max === undefined || n <= range.max);
  if (ok) return n;
  console.error(
    `[previews] ⚠ ${name}=${JSON.stringify(raw)} is not a usable integer; using the default ${fallback}`,
  );
  return fallback;
}
