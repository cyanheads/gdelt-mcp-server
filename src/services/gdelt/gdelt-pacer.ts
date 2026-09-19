/**
 * @fileoverview Outbound pacer shared by every GDELT API call (DOC and TV) — one request
 * in flight, spaced by the configured minimum gap, behind a cooldown gate that an upstream
 * rate limit closes for every queued caller at once.
 * @module services/gdelt/gdelt-pacer
 */

import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';

/**
 * First cooldown the gate closes for when GDELT answers with a rate limit, doubled on each
 * consecutive rate limit up to {@link GDELT_COOLDOWN_MAX_MS} and reset by the first success.
 * GDELT publishes a one-request-per-five-seconds limit, but a tripped window stays shut for
 * roughly a minute and carries no `Retry-After`, so the gate has to widen on its own.
 */
const GDELT_COOLDOWN_BASE_MS = 5_000;

/** Ceiling for the cooldown doubling. */
const GDELT_COOLDOWN_MAX_MS = 60_000;

/**
 * Wait budget for one queued caller, matched to the cooldown ceiling: a request that cannot
 * start before the longest window GDELT ever holds shut is shed rather than parked. A shed
 * spends no upstream request and carries the seconds until a slot opens.
 */
export const GDELT_MAX_QUEUE_WAIT_MS = GDELT_COOLDOWN_MAX_MS;

let _pacer: Pacer | undefined;

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
}

export function getGdeltPacer(): Pacer {
  if (!_pacer) throw new Error('GDELT pacer not initialized — call initGdeltPacer() in setup()');
  return _pacer;
}

/** Release the pacer's timer and reject every queued waiter. Wired to `createApp({ teardown })`. */
export function disposeGdeltPacer(): void {
  _pacer?.dispose();
  _pacer = undefined;
}
