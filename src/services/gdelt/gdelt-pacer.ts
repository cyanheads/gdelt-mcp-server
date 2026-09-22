/**
 * @fileoverview Outbound pacer shared by every GDELT API call (DOC and TV) — one request
 * in flight, spaced from the previous response's completion, behind a cooldown gate that an
 * upstream rate limit closes for every queued caller at once.
 * @module services/gdelt/gdelt-pacer
 */

import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';

/**
 * First cooldown the gate closes for when GDELT answers with a rate limit, doubled on each
 * consecutive rate limit up to {@link GDELT_COOLDOWN_MAX_MS} and reset by the first success.
 * GDELT publishes a one-request-per-five-seconds limit, but a tripped window stays shut far
 * longer than that — measured at a minute and more, across quiet periods — and carries no
 * `Retry-After`, so the gate has to widen on its own.
 */
const GDELT_COOLDOWN_BASE_MS = 5_000;

/** Ceiling for the cooldown doubling. */
const GDELT_COOLDOWN_MAX_MS = 60_000;

/**
 * Wait budget for one queued caller. Deliberately above {@link GDELT_COOLDOWN_MAX_MS} plus a
 * request gap: matched to the ceiling, a caller shed by the budget timer is shed at the exact
 * instant the gate reopens, so it can never wait out a closed gate *and* reach a slot. It stays
 * below the per-call deadline (twice `GDELT_REQUEST_TIMEOUT_MS`), so a caller queued behind one
 * full retry ladder is shed rather than parked. A shed spends no upstream request.
 */
export const GDELT_MAX_QUEUE_WAIT_MS = 90_000;

let _pacer: Pacer | undefined;
let _requestGapMs = 0;
let _lastCompletedAt: number | undefined;

/**
 * Build the process-wide GDELT pacer. `minStartGapMs` is the configured
 * `GDELT_REQUEST_DELAY_MS`; `maxConcurrent: 1` keeps a single request in flight so a slow
 * response never overlaps the next one.
 */
export function initGdeltPacer(minStartGapMs: number): void {
  _pacer = createPacer({
    name: 'gdelt',
    maxConcurrent: 1,
    minStartGapMs,
    cooldown: { baseMs: GDELT_COOLDOWN_BASE_MS, maxMs: GDELT_COOLDOWN_MAX_MS },
  });
  _requestGapMs = minStartGapMs;
  _lastCompletedAt = undefined;
}

export function getGdeltPacer(): Pacer {
  if (!_pacer) throw new Error('GDELT pacer not initialized — call initGdeltPacer() in setup()');
  return _pacer;
}

/**
 * Record that an upstream request settled — success or failure alike, since a rejection spends
 * the slot just as a response does. Read by {@link holdForGdeltRequestGap}.
 */
export function recordGdeltRequestSettled(): void {
  _lastCompletedAt = Date.now();
}

/**
 * Hold until a full request gap has elapsed since the previous request settled.
 *
 * `createPacer` spaces consecutive *starts*: with one request in flight the next start is
 * `max(previous start + gap, previous completion)`, so any response slower than the gap leaves
 * no gap at all after it completes — the normal case against an API that answers in tens of
 * seconds. GDELT's limiter counts from completion, so the hold has to live on this side of the
 * pacer. It runs before the fetch rather than after it, so a caller's own result is never
 * delayed, and `maxConcurrent: 1` means nothing else can start during it.
 *
 * Rejects with the signal's reason if the caller goes away mid-hold.
 */
export function holdForGdeltRequestGap(signal: AbortSignal): Promise<void> {
  if (_lastCompletedAt === undefined) return Promise.resolve();
  const waitMs = _lastCompletedAt + _requestGapMs - Date.now();
  if (waitMs <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, waitMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Release the pacer's timer and reject every queued waiter. Wired to `createApp({ teardown })`. */
export function disposeGdeltPacer(): void {
  _pacer?.dispose();
  _pacer = undefined;
  _requestGapMs = 0;
  _lastCompletedAt = undefined;
}
