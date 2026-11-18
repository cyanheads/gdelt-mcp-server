/**
 * @fileoverview Outbound pacing for every GDELT API request (DOC, Context, and TV). One request
 * is in flight across all three, sent a full gap after the previous response settled. In front of
 * that shared slot each endpoint has its own cooldown, closed only by that endpoint's rate limits
 * and reset only by its own success: GDELT throttles the three APIs separately.
 * @module services/gdelt/gdelt-pacer
 */

import { createPacer, type Pacer, type PacerCooldownState } from '@cyanheads/mcp-ts-core/utils';

/**
 * First cooldown an endpoint closes for when GDELT answers it with a rate limit, doubled on each
 * consecutive rate limit from that endpoint up to {@link GDELT_COOLDOWN_MAX_MS} and reset by its
 * first success. GDELT publishes a one-request-per-five-seconds limit, but a tripped window stays
 * shut far longer than that — measured at a minute and more, across quiet periods — and carries
 * no `Retry-After`, so the cooldown has to widen on its own.
 */
const GDELT_COOLDOWN_BASE_MS = 5_000;

/** Ceiling for the cooldown doubling. */
const GDELT_COOLDOWN_MAX_MS = 60_000;

/**
 * Wait budget for one queued caller, covering its wait on its endpoint's cooldown and its wait
 * for the shared slot together. Deliberately above {@link GDELT_COOLDOWN_MAX_MS} plus a request
 * gap: matched to the ceiling, a caller shed by the budget timer is shed at the exact instant the
 * cooldown ends, so it can never wait out a closed cooldown *and* reach a slot. It stays below
 * the per-call deadline (twice `GDELT_REQUEST_TIMEOUT_MS`), so a caller queued behind one full
 * retry ladder is shed rather than parked. A shed spends no upstream request.
 */
export const GDELT_MAX_QUEUE_WAIT_MS = 90_000;

/** One endpoint's pacing, as {@link getGdeltPacer} hands it out. */
export interface GdeltEndpointPacer {
  /** The endpoint's cooldown, sampled when read. Only this endpoint's rate limits close it. */
  readonly cooldown: PacerCooldownState;
  /**
   * Run `request` once this endpoint's cooldown is open, the shared slot is free, and a full gap
   * has passed since the previous request settled. `request` is the upstream call alone: it runs
   * past every wait, and its settling, success or failure, starts the next gap. A `RateLimited`
   * `McpError` it rejects with closes this endpoint's cooldown.
   *
   * @throws {McpError} `RateLimited` with `data.reason: 'pacer_shed'` when the call cannot start
   *   within {@link GDELT_MAX_QUEUE_WAIT_MS}, before any request is sent.
   */
  run<T>(
    request: (signal: AbortSignal) => Promise<T>,
    options: { signal: AbortSignal },
  ): Promise<T>;
}

let _slot: Pacer | undefined;
let _requestGapMs = 0;
let _lastCompletedAt: number | undefined;
/** Each endpoint's cooldown pacer, created on its first request, keyed by endpoint URL. */
const _endpoints = new Map<string, { pacer: GdeltEndpointPacer; cooldownPacer: Pacer }>();

/**
 * Build the process-wide shared slot. `minStartGapMs` is the configured `GDELT_REQUEST_DELAY_MS`;
 * `maxConcurrent: 1` keeps a single request in flight so a slow response never overlaps the next
 * one. The slot carries no cooldown: a rate limit gates only the endpoint that returned it.
 */
export function initGdeltPacer(minStartGapMs: number): void {
  _slot = createPacer({ name: 'gdelt', maxConcurrent: 1, minStartGapMs });
  _requestGapMs = minStartGapMs;
  _lastCompletedAt = undefined;
}

/**
 * The pacing for one GDELT endpoint — `gdeltFetch`'s `baseUrl`, so DOC, TV (its station catalog
 * included), and Context each get their own, created on first use.
 *
 * Each endpoint's framework pacer holds its cooldown and lets one call at a time through to the
 * shared slot. A call therefore waits out its endpoint's cooldown without holding the slot, and
 * the cooldown is checked once the previous request on that endpoint has settled: a call queued
 * behind a request that draws a rate limit waits for the cooldown that rate limit closed instead
 * of following it into the closed window. Its start gap matches the slot's, so the framework can
 * project a burst on one endpoint and shed an arrival that cannot start within the budget at once.
 * After a request that went out it never binds, since the next start on that endpoint follows the
 * request's settle and the slot then holds a full gap anyway; only after a call that left before
 * its request was sent (cancelled, or shed from the slot's queue) can it hold the next call on that
 * endpoint for up to one gap.
 */
export function getGdeltPacer(endpoint: string): GdeltEndpointPacer {
  const slot = _slot;
  if (!slot) throw new Error('GDELT pacer not initialized — call initGdeltPacer() in setup()');
  const existing = _endpoints.get(endpoint);
  if (existing) return existing.pacer;

  const cooldownPacer = createPacer({
    name: `gdelt-${endpoint.slice(endpoint.lastIndexOf('/') + 1)}`,
    maxConcurrent: 1,
    minStartGapMs: _requestGapMs,
    cooldown: { baseMs: GDELT_COOLDOWN_BASE_MS, maxMs: GDELT_COOLDOWN_MAX_MS },
  });
  const pacer: GdeltEndpointPacer = {
    get cooldown() {
      return cooldownPacer.cooldown;
    },
    run(request, { signal }) {
      const enqueuedAt = Date.now();
      return cooldownPacer.run(
        (cooldownSignal) =>
          slot.run(
            async (slotSignal) => {
              await holdForRequestGap(slotSignal);
              try {
                return await request(slotSignal);
              } finally {
                _lastCompletedAt = Date.now();
              }
            },
            {
              signal: cooldownSignal,
              maxWaitMs: Math.max(0, GDELT_MAX_QUEUE_WAIT_MS - (Date.now() - enqueuedAt)),
            },
          ),
        { signal, maxWaitMs: GDELT_MAX_QUEUE_WAIT_MS },
      );
    },
  };
  _endpoints.set(endpoint, { pacer, cooldownPacer });
  return pacer;
}

/**
 * Hold until a full request gap has elapsed since the previous request settled — success or
 * failure alike, since a rejection spends the slot just as a response does.
 *
 * `createPacer` spaces consecutive *starts*: with one request in flight the next start is
 * `max(previous start + gap, previous completion)`, so any response slower than the gap leaves
 * no gap at all after it completes — the normal case against an API that answers in tens of
 * seconds. GDELT's limiter counts from completion, so the hold has to live on this side of the
 * pacer. It runs before the request rather than after it, so a caller's own result is never
 * delayed, and `maxConcurrent: 1` means nothing else can start during it.
 *
 * Rejects with the signal's reason if the caller goes away mid-hold.
 */
function holdForRequestGap(signal: AbortSignal): Promise<void> {
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

/** Release every pacer's timer and reject every queued waiter. Wired to `createApp({ teardown })`. */
export function disposeGdeltPacer(): void {
  for (const { cooldownPacer } of _endpoints.values()) cooldownPacer.dispose();
  _endpoints.clear();
  _slot?.dispose();
  _slot = undefined;
  _requestGapMs = 0;
  _lastCompletedAt = undefined;
}
