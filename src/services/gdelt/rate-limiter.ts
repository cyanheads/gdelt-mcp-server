/**
 * @fileoverview Shared rate limiter for GDELT API calls. Enforces 1 request per 5 seconds
 * across all API calls (DOC and TV) via a serial queue with minimum delay.
 * @module services/gdelt/rate-limiter
 */

/** Singleton that serializes all GDELT API calls with a minimum inter-request delay. */
export class GdeltRateLimiter {
  private lastRequestTime = 0;
  private queue: Array<() => void> = [];
  private processing = false;

  constructor(private readonly delayMs: number) {}

  /** Acquire a rate-limit slot. Resolves when it is safe to issue the next request. */
  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      if (!this.processing) this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.delayMs) {
        await new Promise<void>((r) => setTimeout(r, this.delayMs - elapsed));
      }
      this.lastRequestTime = Date.now();
      const next = this.queue.shift();
      next?.();
    }
    this.processing = false;
  }
}

let _limiter: GdeltRateLimiter | undefined;

export function initRateLimiter(delayMs: number): void {
  _limiter = new GdeltRateLimiter(delayMs);
}

export function getRateLimiter(): GdeltRateLimiter {
  if (!_limiter)
    throw new Error('GdeltRateLimiter not initialized — call initRateLimiter() in setup()');
  return _limiter;
}
