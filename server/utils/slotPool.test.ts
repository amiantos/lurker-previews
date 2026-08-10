// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { SlotPool } from './slotPool.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('SlotPool', () => {
  it('hands out its slots without making anyone wait', async () => {
    const pool = new SlotPool({ size: 3, maxQueued: 10, waitMs: 50 });
    expect(await pool.acquire()).toBe(true);
    expect(await pool.acquire()).toBe(true);
    expect(await pool.acquire()).toBe(true);
    expect(pool.inFlight).toBe(3);
    expect(pool.queued).toBe(0);
  });

  it('queues past the size rather than refusing', async () => {
    const pool = new SlotPool({ size: 1, maxQueued: 10, waitMs: 1000 });
    expect(await pool.acquire()).toBe(true);

    let got: boolean | null = null;
    const waiting = pool.acquire().then((v) => (got = v));
    await tick();
    expect(got).toBeNull();
    expect(pool.queued).toBe(1);

    pool.release();
    await waiting;
    expect(got).toBe(true);
    // Still one slot out — it moved from the releaser to the waiter, it wasn't returned.
    expect(pool.inFlight).toBe(1);
    expect(pool.queued).toBe(0);
  });

  it('hands a freed slot to the WAITER, not to whoever asks next', async () => {
    // ⚠⚠ Regression guard. A released slot used to go back into the pool for anyone to grab,
    // with the woken waiter re-checking the count on a later turn of the loop — so a fresh
    // arrival could take it synchronously and the waiter would spin until its deadline, having
    // already cleared it. Under a steady arrival rate that waiter starves indefinitely.
    const pool = new SlotPool({ size: 1, maxQueued: 10, waitMs: 1000 });
    await pool.acquire();

    const order: string[] = [];
    const waiter = pool.acquire().then((ok) => order.push(`waiter:${ok}`));
    await tick();

    pool.release();
    // A latecomer asking in the very same tick as the release must NOT get in first.
    const latecomer = pool.acquire().then((ok) => order.push(`latecomer:${ok}`));

    await waiter;
    expect(order[0]).toBe('waiter:true');

    pool.release();
    await latecomer;
    expect(order[1]).toBe('latecomer:true');
  });

  it('refuses immediately once the queue is full', async () => {
    const pool = new SlotPool({ size: 1, maxQueued: 2, waitMs: 1000 });
    await pool.acquire();
    const parked = [pool.acquire(), pool.acquire()];
    await tick();
    expect(pool.queued).toBe(2);

    // The third would-be waiter is turned away rather than growing the queue.
    expect(await pool.acquire()).toBe(false);

    pool.release();
    await parked[0];
    pool.release();
    await parked[1];
  });

  it('gives up after the deadline without taking a slot with it', async () => {
    const pool = new SlotPool({ size: 1, maxQueued: 10, waitMs: 20 });
    await pool.acquire();

    expect(await pool.acquire()).toBe(false);
    expect(pool.queued).toBe(0);
    // The one real holder still holds exactly one slot: giving up must not have counted as
    // taking one, or the pool would shrink by a slot for every timeout it ever serves.
    expect(pool.inFlight).toBe(1);

    pool.release();
    expect(pool.inFlight).toBe(0);
    expect(await pool.acquire()).toBe(true);
  });

  it('does not hand a slot to a caller that already gave up', async () => {
    const pool = new SlotPool({ size: 1, maxQueued: 10, waitMs: 20 });
    await pool.acquire();
    expect(await pool.acquire()).toBe(false);

    // The release finds no live waiter, so the slot goes back to the pool rather than being
    // handed to a promise nobody is awaiting any more.
    pool.release();
    expect(pool.inFlight).toBe(0);
  });
});
