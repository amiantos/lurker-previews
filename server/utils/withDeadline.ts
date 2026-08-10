// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

/** Thrown when work loses its race against a deadline, so a caller can tell that apart from
 *  the work itself failing — one is a fact about a moment, the other about the work. */
export class DeadlineExceeded extends Error {}

/**
 * Race a promise against a deadline.
 *
 * ⚠ Losing the race ABANDONS the work rather than cancelling it — there is no cancellation in
 * a plain promise, so an in-flight fetch keeps its socket until its own timeout fires. What
 * this bounds is how long a caller waits and how long any resource it holds on the way in (a
 * pool slot, an HTTP response) is held hostage. That is the part that affects everyone else,
 * and claiming more than that would be a comment asserting a guarantee it doesn't provide.
 *
 * The timer is cleared on both outcomes and unref'd, so a pending deadline can never be the
 * reason the process stays up.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, what = 'work'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceeded(`${what} exceeded ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
