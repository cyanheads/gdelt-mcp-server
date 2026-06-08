/**
 * @fileoverview Tests for GdeltRateLimiter — serial queue with minimum inter-request delay.
 * @module tests/services/rate-limiter.test
 */

import { describe, expect, it } from 'vitest';
import { GdeltRateLimiter } from '@/services/gdelt/rate-limiter.js';

describe('GdeltRateLimiter', () => {
  it('resolves the first acquire immediately (no previous request)', async () => {
    const limiter = new GdeltRateLimiter(0);
    const start = Date.now();
    await limiter.acquire();
    // Should resolve in well under 50 ms with a 0 ms delay
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('serializes concurrent acquires so they resolve one at a time', async () => {
    const limiter = new GdeltRateLimiter(0);
    const order: number[] = [];
    const [p1, p2, p3] = [
      limiter.acquire().then(() => order.push(1)),
      limiter.acquire().then(() => order.push(2)),
      limiter.acquire().then(() => order.push(3)),
    ];
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('enforces minimum delay between consecutive acquires', async () => {
    const delayMs = 50;
    const limiter = new GdeltRateLimiter(delayMs);

    const t0 = Date.now();
    await limiter.acquire();
    const t1 = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - t0;

    // Two acquires with 50 ms delay between them should take at least ~50 ms total.
    // We're lenient with the upper bound to avoid flakiness on slow CI.
    expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);
    // First acquire should still be fast
    expect(t1 - t0).toBeLessThan(delayMs + 50);
  });

  it('processes all queued requests when multiple are pending', async () => {
    const limiter = new GdeltRateLimiter(0);
    let count = 0;
    const tasks = Array.from({ length: 5 }, () =>
      limiter.acquire().then(() => {
        count++;
      }),
    );
    await Promise.all(tasks);
    expect(count).toBe(5);
  });

  // ── Abort signal tests ────────────────────────────────────────────────────

  it('rejects immediately when signal is already aborted before acquire', async () => {
    const limiter = new GdeltRateLimiter(0);
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.acquire(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects with AbortError when signal fires while queued', async () => {
    // Use a small delay so the second acquire has time to queue before we abort.
    const limiter = new GdeltRateLimiter(50);
    const controller = new AbortController();

    // First acquire takes the slot; second will queue.
    const first = limiter.acquire();
    const second = limiter.acquire(controller.signal);

    // Abort the second caller while it is queued.
    controller.abort();

    await first; // first should still resolve normally
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not block subsequent callers when a queued entry is aborted', async () => {
    // With a 50 ms delay: first acquire takes 0 ms, second (aborted) is
    // removed, third should proceed after ~50 ms — not ~100 ms.
    const delayMs = 50;
    const limiter = new GdeltRateLimiter(delayMs);
    const controller = new AbortController();

    const t0 = Date.now();
    const first = limiter.acquire(); // resolves immediately
    const second = limiter.acquire(controller.signal); // queued, will be aborted
    const third = limiter.acquire(); // queued behind second

    // Let the queue process the first slot, then abort second.
    await first;
    controller.abort();

    // second rejects; third should resolve after one delay (~50 ms from first resolve)
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await third;

    // Total elapsed should be ~delayMs, NOT ~2×delayMs
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);
    expect(elapsed).toBeLessThan(delayMs * 2 - 10);
  });

  it('resolves normally when signal is provided but never fired', async () => {
    const limiter = new GdeltRateLimiter(0);
    const controller = new AbortController();
    await expect(limiter.acquire(controller.signal)).resolves.toBeUndefined();
  });
});
