// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A counting semaphore with a bounded queue and a wait deadline.
//
// Extracted from the link-preview resolver rather than left inline because its two interesting
// properties — a slot is HANDED OVER rather than released into a contest, and a caller that
// gives up waiting must not leak the slot it never took — are exactly the kind that break
// silently under load and can't be observed from an HTTP test. Both had already shipped as
// bugs once (see the notes on `release` and `acquire`).

interface Waiter {
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (got: boolean) => void;
}

export interface SlotPoolConfig {
  /** Slots available at once. */
  size: number;
  /** Callers allowed to park waiting for one. A flood must not grow this without limit. */
  maxQueued: number;
  /** How long a caller waits before giving up. */
  waitMs: number;
}

export class SlotPool {
  private taken = 0;
  private waiters: Waiter[] = [];

  constructor(private readonly cfg: SlotPoolConfig) {}

  /** Slots currently held. */
  get inFlight(): number {
    return this.taken;
  }

  /** Callers parked waiting for one. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Take a slot, waiting if none is free. Resolves false only if it gave up — either the queue
   * was already full or the deadline lapsed.
   *
   * ⚠ A `false` means "we couldn't ask right now", never "this work is impossible". Callers
   * must not cache a verdict derived from it.
   */
  async acquire(): Promise<boolean> {
    if (this.taken < this.cfg.size) {
      this.taken++;
      return true;
    }
    if (this.waiters.length >= this.cfg.maxQueued) return false;

    return await new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        settled: false,
        resolve,
        timer: setTimeout(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const at = this.waiters.indexOf(waiter);
          if (at !== -1) this.waiters.splice(at, 1);
          // No decrement: this caller never held a slot, it was only queued for one.
          resolve(false);
        }, this.cfg.waitMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /**
   * Give a slot back.
   *
   * ⚠ The slot is HANDED OVER to the next waiter, not released into a free-for-all, and the
   * counter is deliberately NOT decremented on that path. An earlier version woke a waiter and
   * had it re-check the count in a `while (…) await setImmediate` loop — so a brand-new caller
   * could take the just-freed slot synchronously before the woken waiter's microtask ran,
   * leaving the waiter spinning on setImmediate with its own timeout already cleared: a starved
   * caller burning a core, and an HTTP request hanging well past the bound meant to prevent
   * exactly that.
   */
  release(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift() as Waiter;
      // Belt and braces: a settled waiter is spliced out by its own timer, so it shouldn't be
      // here — but skipping rather than handing it the slot is what keeps a lost race from
      // silently shrinking the pool for the life of the process.
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      waiter.resolve(true);
      return;
    }
    this.taken--;
  }
}
