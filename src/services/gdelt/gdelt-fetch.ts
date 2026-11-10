/**
 * @fileoverview Shared fetch helper for GDELT API calls. Handles rate-limiting,
 * retries, HTML error detection, and JSON parsing.
 * @module services/gdelt/gdelt-fetch
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  requestCancelled,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { quoteText } from '@/mcp-server/tools/markdown-escape.js';
import type { StaleResponse } from '@/mcp-server/tools/stale-response.js';
import {
  GDELT_MAX_QUEUE_WAIT_MS,
  getGdeltPacer,
  holdForGdeltRequestGap,
  recordGdeltRequestSettled,
} from './gdelt-pacer.js';
import {
  type FetchedAnswer,
  GDELT_CACHE_MAX_ENTRY_BYTES,
  GDELT_CACHE_RETENTION_MS,
  type GdeltCacheEntry,
  type GdeltResponseCache,
  type GdeltSharedFetch,
  getGdeltResponseCache,
} from './gdelt-response-cache.js';

/** Stable public recovery for every GDELT rate-limit response shape. */
const GDELT_RATE_LIMIT_RECOVERY = {
  hint: 'Back off before retrying; five seconds is minimum request spacing, not a recovery guarantee, and rate limiting may persist longer. Honor Retry-After when supplied.',
} as const;

/** Internal retry suppression shared by rate-limit shapes; gdeltFetch restores public retryability. */
const GDELT_RATE_LIMIT_DATA = {
  reason: 'gdelt_rate_limited',
  retryable: false,
  recovery: GDELT_RATE_LIMIT_RECOVERY,
} as const;

/**
 * The `gdelt_unavailable` contract entry every upstream-backed tool declares, as it reaches
 * the wire. The hint is the declared `recovery` for that reason; the service layer throws
 * below `ctx.fail`, so it is carried here rather than resolved from the contract.
 */
export const GDELT_UNAVAILABLE_DATA = {
  reason: 'gdelt_unavailable',
  retryable: true,
  recovery: { hint: 'Retry after a short delay; GDELT may be temporarily unavailable.' },
} as const;

/**
 * The whole call's wall-clock budget, as a multiple of `GDELT_REQUEST_TIMEOUT_MS`. Derived
 * rather than configured separately, since the two numbers are only meaningful against each
 * other. At 2× it is the deadline rather than the attempt count that bounds the ladder: two
 * timeout-length attempts fit, and four fast failures still do. The TV service's station-catalog
 * wait never runs past this deadline either, counted from the start of the tool call.
 */
export const GDELT_CALL_DEADLINE_MULTIPLIER = 2;

/**
 * Longest a call waits on GDELT, counted from its start, while it holds something else to answer
 * with: a stored answer to serve stale, a caller's own fallback (see
 * {@link GdeltFetchOptions.hasFallback}), or the TV service's answer still missing station labels.
 * MCP clients commonly give up on a call at 60 seconds, so the wait ends well inside that, leaving
 * the fallback time to answer, rather than at the call deadline.
 */
export const GDELT_FALLBACK_BUDGET_MS = 45_000;

/** Apply timespan or explicit date range to URL params. */
export function applyTimeRange(
  params: URLSearchParams,
  timespan?: string,
  startDatetime?: string,
  endDatetime?: string,
): void {
  if (startDatetime && endDatetime) {
    params.set('startdatetime', startDatetime);
    params.set('enddatetime', endDatetime);
  } else if (timespan?.trim()) {
    params.set('timespan', timespan);
  }
}

/**
 * Resolve a GDELT timespan string (e.g. "1y", "6m", "7d", "24h", "15min") to an
 * absolute `{ start, end }` date range anchored to now.
 * Returns `undefined` when the string cannot be parsed.
 *
 * Steps back in UTC, as GDELT reads `timespan`: hours, days, and weeks are exact multiples of
 * an hour whatever the server's zone, and months and years step by the UTC calendar. Local-time
 * setters would stretch or shrink a window that crosses a daylight-saving change by an hour.
 */
export function resolveTimespan(timespan: string): { start: Date; end: Date } | undefined {
  const parsed = parseGdeltTimespan(timespan);
  if (!parsed) return;
  const { amount: n, unit } = parsed;
  const end = new Date();
  const start = new Date(end);
  switch (unit) {
    case 'min':
      start.setUTCMinutes(start.getUTCMinutes() - n);
      break;
    case 'h':
      start.setUTCHours(start.getUTCHours() - n);
      break;
    case 'd':
      start.setUTCDate(start.getUTCDate() - n);
      break;
    case 'w':
      start.setUTCDate(start.getUTCDate() - n * 7);
      break;
    case 'm':
      start.setUTCMonth(start.getUTCMonth() - n);
      break;
    case 'y':
      start.setUTCFullYear(start.getUTCFullYear() - n);
      break;
  }
  return { start, end };
}

/** Supported relative units; unknown numeric-plus-unit syntax remains upstream-owned. */
const TIMESPAN_UNITS = new Map<string, 'min' | 'h' | 'd' | 'w' | 'm' | 'y'>([
  ['min', 'min'],
  ['h', 'h'],
  ['hours', 'h'],
  ['d', 'd'],
  ['days', 'd'],
  ['w', 'w'],
  ['week', 'w'],
  ['weeks', 'w'],
  ['m', 'm'],
  ['months', 'm'],
  ['y', 'y'],
  ['years', 'y'],
]);

/** Parse supported relative units without rejecting upstream-evolved syntax. */
export function parseGdeltTimespan(timespan: string) {
  const match = /^(\d+)([a-z]+)$/i.exec(timespan.trim());
  if (!match) return;
  const unit = TIMESPAN_UNITS.get((match[2] as string).toLowerCase());
  if (unit) return { amount: Number(match[1]), unit };
  return;
}

/** Format a Date as YYYY-MM-DD for human-readable display. */
export function formatDateShort(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Per-call options for {@link gdeltFetch}. */
export type GdeltFetchOptions = {
  /**
   * Overrides the ladder's retry count — 0 for a best-effort side lookup that must not hold its
   * caller through backoffs.
   */
  maxRetries?: number;
  /**
   * Take a stored answer only while it is fresh, and never serve one stale. For a lookup that
   * runs on another call's `ctx`, where a stale serve would mark that call's own answer stale.
   */
  freshOnly?: boolean;
  /**
   * The caller holds its own answer to fall back on, such as the local GKG mirror. A call made
   * while the pacer's cooldown gate is closed rejects at once with `gdelt_rate_limited`, spending
   * no request and no queue slot. Otherwise the call stops waiting on GDELT
   * {@link GDELT_FALLBACK_BUDGET_MS} after it started and rejects with the classified reason, so
   * the fallback still answers inside the client's timeout: `gdelt_rate_limited` while no request
   * has gone upstream (queued, or held behind the request gap), `gdelt_unavailable` once one has.
   * Code, reason, and recovery hint are those of every other failure with that reason. A stored
   * answer that can be served stale still wins: the call serves it, at once behind a closed gate
   * or at the budget, instead of rejecting.
   */
  hasFallback?: boolean;
};

/**
 * When a caller holding something else to answer with stops waiting on a shared fetch: at the
 * epoch-millisecond instant `at`, if `holds()` still says it holds it then.
 */
type FallbackBudget = { readonly at: number; readonly holds: () => boolean };

/** Freshness of an answer whose window may still be filling: GDELT 2.0's update interval. */
const GDELT_FRESH_MS = 15 * 60 * 1000;

/**
 * Freshness of an answer whose window ended more than {@link GDELT_SETTLE_LAG_MS} before its
 * fetch, by which time GDELT has finished indexing it.
 */
const GDELT_SETTLED_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * How long after a window ends GDELT may still add to it: TV's documented processing lag of up
 * to 24 hours, which also covers DOC's undocumented indexing lag behind each 15-minute batch.
 */
const GDELT_SETTLE_LAG_MS = 24 * 60 * 60 * 1000;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Fetch a GDELT endpoint through the process-wide response cache and the shared pacer, with
 * retries and JSON parsing.
 *
 * **Cache.** The key is the exact URL, no further normalization: a `timespan` goes upstream
 * verbatim, so its key does not move with the clock, and the freshness window bounds its
 * drift. A fresh hit is answered before the retry ladder, so it sends no request and takes no
 * pacer slot, request gap, or cooldown wait. Each hit decodes and parses its own copy of the
 * stored bytes, so no two callers share objects. Only a parsed answer holding a non-empty
 * top-level array is stored: refusals, failures, and empty answers (GDELT's `{}` among them)
 * are returned as before and the next identical call asks again.
 *
 * **Shared fetch.** Concurrent calls for the same URL with the same `maxRetries` share one
 * fetch, run under its own signal and deadline. Each caller waits on its own `ctx.signal`: one
 * that leaves while others wait fails alone with `RequestCancelled`, and the last to leave
 * aborts the fetch with its own abort reason, failing exactly as an unshared call would.
 *
 * **Stale serve.** When the refetch fails with `gdelt_rate_limited` or `gdelt_unavailable` —
 * decided on the final classified error — or comes back empty, which GDELT also answers under
 * load, the stored answer is returned while it is servable (see {@link staleServableMs}), what it
 * absorbed is logged at warning level, and the call's `staleResponse` enrichment discloses it.
 * With nothing servable, an empty answer is returned as it came. Neither `invalid_query`, a
 * serialization failure, nor the caller's own cancellation ever falls back, and neither does a
 * `freshOnly` call.
 *
 * **Under the client timeout.** A call holding a servable answer never waits past what a client
 * will: while the pacer's cooldown gate is closed, GDELT is rate-limiting this server, so the
 * answer is served at once as `gdelt_rate_limited`, spending no request and no queue slot.
 * Otherwise the call waits at most {@link GDELT_FALLBACK_BUDGET_MS} from its start, then serves it
 * as `gdelt_rate_limited` if its request never went upstream or `gdelt_unavailable` if it did. A
 * caller passing {@link GdeltFetchOptions.hasFallback} is held to the same gate and budget,
 * rejecting where a stored answer would be served. Leaving at the budget aborts the shared fetch
 * only when no other caller still waits on it. A call with neither waits exactly as long as the
 * fetch takes.
 */
export async function gdeltFetch<T>(
  baseUrl: string,
  params: URLSearchParams,
  ctx: Context,
  operation: string,
  apiLabel: string,
  { maxRetries, freshOnly = false, hasFallback = false }: GdeltFetchOptions = {},
): Promise<T> {
  const startedAt = Date.now();
  const url = `${baseUrl}?${params.toString()}`;
  const cache = getGdeltResponseCache();
  const stored = cache.get(url);
  if (stored && startedAt < stored.freshUntil) {
    ctx.log.debug(`${apiLabel} API answered from cache`, { url, ageSeconds: ageSeconds(stored) });
    return parseStored<T>(stored);
  }

  const servable = servableEntry(cache, url, ctx, freshOnly);
  if (servable || hasFallback) {
    const cooldownRemainingMs = getGdeltPacer().cooldown.remainingMs;
    if (cooldownRemainingMs > 0) {
      if (servable) {
        return serveStale<T>(servable, 'gdelt_rate_limited', ctx, apiLabel, {
          cooldownRemainingMs,
        });
      }
      throw rateLimited(
        `${apiLabel} API is rate-limiting this server; its cooldown ends in ${Math.ceil(cooldownRemainingMs / 1000)}s.`,
        { ...GDELT_RATE_LIMIT_DATA, retryable: true },
      );
    }
  }
  const budget: FallbackBudget | undefined =
    servable || hasFallback
      ? {
          at: startedAt + GDELT_FALLBACK_BUDGET_MS,
          holds: () => hasFallback || servableEntry(cache, url, ctx, freshOnly) !== undefined,
        }
      : undefined;

  let answer: T;
  try {
    answer = await joinSharedFetch<T>(
      cache,
      url,
      params,
      ctx,
      operation,
      apiLabel,
      maxRetries,
      budget,
    );
  } catch (error) {
    if (!(error instanceof McpError)) throw error;
    const reason = gdeltRefusalReason(error);
    const standIn = reason && servableEntry(cache, url, ctx, freshOnly);
    if (!reason || !standIn) throw error;
    return serveStale<T>(standIn, reason, ctx, apiLabel, {
      code: error.code,
      error: error.message,
    });
  }
  if (hasNonEmptyArray(answer)) return answer;
  const standIn = servableEntry(cache, url, ctx, freshOnly);
  return standIn ? serveStale<T>(standIn, 'gdelt_empty', ctx, apiLabel, {}) : answer;
}

/**
 * The stored answer that may stand in for a refetch that gave this caller no data, if one is
 * still servable. Never for a `freshOnly` call or a caller that has cancelled.
 */
function servableEntry(
  cache: GdeltResponseCache,
  url: string,
  ctx: Context,
  freshOnly: boolean,
): GdeltCacheEntry | undefined {
  if (freshOnly || ctx.signal.aborted) return;
  const entry = cache.get(url);
  return entry && Date.now() < entry.staleUntil ? entry : undefined;
}

/** Serve a stored answer in place of the refetch: log what it absorbed and disclose it. */
function serveStale<T>(
  entry: GdeltCacheEntry,
  reason: StaleResponse['reason'],
  ctx: Context,
  apiLabel: string,
  absorbed: Record<string, unknown>,
): T {
  const staleResponse = {
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    ageSeconds: ageSeconds(entry),
    reason,
  } satisfies StaleResponse;
  ctx.log.warning(`${apiLabel} API refetch gave no data; serving the stored answer`, {
    ...staleResponse,
    ...absorbed,
  });
  ctx.enrich({ staleResponse });
  return parseStored<T>(entry);
}

/**
 * The declared refusal `error` is, if it is one: GDELT rate-limited the call or did not answer it
 * with data. A stored answer or the caller's own fallback may stand in for exactly these.
 */
export function gdeltRefusalReason(
  error: McpError,
): 'gdelt_rate_limited' | 'gdelt_unavailable' | undefined {
  const reason = error.data?.reason;
  if (error.code === JsonRpcErrorCode.RateLimited && reason === 'gdelt_rate_limited') {
    return reason;
  }
  if (error.code === JsonRpcErrorCode.ServiceUnavailable && reason === 'gdelt_unavailable') {
    return reason;
  }
  return;
}

/** A stored answer's age, in whole seconds. */
function ageSeconds(entry: GdeltCacheEntry): number {
  return Math.floor((Date.now() - entry.fetchedAt) / 1000);
}

/** Decode and parse a caller's own copy of a stored answer. */
function parseStored<T>(entry: GdeltCacheEntry): T {
  return JSON.parse(utf8Decoder.decode(entry.body)) as T;
}

/**
 * Wait on the fetch in flight for `url` and `maxRetries`, starting it if there is none, and
 * return this caller's own copy of its answer: the first waiter takes the parse the fetch made,
 * every other one parses the body again.
 */
async function joinSharedFetch<T>(
  cache: GdeltResponseCache,
  url: string,
  params: URLSearchParams,
  ctx: Context,
  operation: string,
  apiLabel: string,
  maxRetries: number | undefined,
  budget: FallbackBudget | undefined,
): Promise<T> {
  const key = `${maxRetries ?? 'ladder'} ${url}`;
  let shared = cache.inFlight.get(key);
  if (!shared) {
    const controller = new AbortController();
    const fetchCtx: Context = { ...ctx, signal: controller.signal };
    let sent = false;
    shared = {
      result: fetchFromGdelt(url, fetchCtx, operation, apiLabel, maxRetries, () => {
        sent = true;
      }).then((answer) => {
        storeAnswer(cache, url, params, answer);
        return answer;
      }),
      controller,
      sent: () => sent,
      waiters: 0,
      valueTaken: false,
    };
    cache.inFlight.set(key, shared);
  }
  shared.waiters += 1;
  const answer = await waitForSharedFetch(cache, key, shared, ctx.signal, apiLabel, budget);
  if (shared.valueTaken) return JSON.parse(answer.text) as T;
  shared.valueTaken = true;
  return answer.value as T;
}

/**
 * One caller's wait on a shared fetch. While other callers still wait, an abort rejects this
 * one alone with `RequestCancelled`. The last caller to leave aborts the fetch with its own
 * abort reason and takes the fetch's classified abort — `RequestCancelled` mid-fetch, `Timeout`
 * for a `TimeoutError` reason, the reason itself mid-backoff — so an unshared call cancels
 * exactly as it did before fetches were shared. A fetch leaves `inFlight` as it settles, or
 * the moment its last caller leaves, so a later call never joins an abandoned one.
 *
 * A caller with a `budget` that still holds its fallback at `budget.at` leaves the same way,
 * rejecting with {@link fallbackBudgetElapsed}'s classified error instead of the fetch's.
 */
function waitForSharedFetch(
  cache: GdeltResponseCache,
  key: string,
  shared: GdeltSharedFetch,
  signal: AbortSignal,
  apiLabel: string,
  budget: FallbackBudget | undefined,
): Promise<FetchedAnswer> {
  const release = () => {
    if (cache.inFlight.get(key) === shared) cache.inFlight.delete(key);
  };
  return new Promise((resolve, reject) => {
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const stopWaiting = () => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(budgetTimer);
    };
    /** Leave the fetch, aborting it with `reason` if no caller is left; true when none is. */
    const leave = (reason: unknown): boolean => {
      stopWaiting();
      shared.waiters -= 1;
      if (shared.waiters > 0) return false;
      release();
      shared.controller.abort(reason);
      return true;
    };
    const onAbort = () => {
      if (!leave(signal.reason)) {
        reject(requestCancelled('Request cancelled while waiting on a shared GDELT request.'));
        return;
      }
      shared.result.then(resolve, reject);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (budget) {
      budgetTimer = setTimeout(() => {
        if (!budget.holds()) return;
        const error = fallbackBudgetElapsed(apiLabel, shared.sent());
        /**
         * Not `error` itself: a fetch held behind the request gap rejects from inside its paced
         * task with the abort reason, and a `RateLimited` one would close the cooldown gate.
         */
        leave(new Error('No caller is still waiting on this GDELT request.'));
        reject(error);
      }, budget.at - Date.now());
    }
    shared.result.then(
      (answer) => {
        stopWaiting();
        release();
        resolve(answer);
      },
      (error: unknown) => {
        stopWaiting();
        release();
        reject(error);
      },
    );
  });
}

/**
 * The failure a caller leaving at {@link GDELT_FALLBACK_BUDGET_MS} takes, classified as the
 * declared contract entry it stands for: `gdelt_unavailable` once a request went upstream and
 * GDELT has not answered it with data, `gdelt_rate_limited` while the request is still waiting
 * its turn under the pacer. Each carries the same public `data` as every other failure with
 * that reason.
 */
function fallbackBudgetElapsed(apiLabel: string, sent: boolean): McpError {
  const seconds = GDELT_FALLBACK_BUDGET_MS / 1000;
  return sent
    ? serviceUnavailable(`${apiLabel} API did not answer within ${seconds}s.`, {
        ...GDELT_UNAVAILABLE_DATA,
      })
    : rateLimited(
        `${apiLabel} API request was still waiting for a request slot after ${seconds}s.`,
        { ...GDELT_RATE_LIMIT_DATA, retryable: true },
      );
}

/**
 * Store an answer worth keeping: one whose parse holds a non-empty top-level array and whose
 * body fits {@link GDELT_CACHE_MAX_ENTRY_BYTES}. A body's UTF-8 length is never below its
 * UTF-16 length, so an oversized one is skipped before it is encoded.
 */
function storeAnswer(
  cache: GdeltResponseCache,
  url: string,
  params: URLSearchParams,
  { text, value }: FetchedAnswer,
): void {
  if (!hasNonEmptyArray(value) || text.length > GDELT_CACHE_MAX_ENTRY_BYTES) return;
  const fetchedAt = Date.now();
  cache.set(url, {
    body: utf8Encoder.encode(text),
    fetchedAt,
    freshUntil: fetchedAt + freshnessMs(params, fetchedAt),
    staleUntil: fetchedAt + staleServableMs(params),
  });
}

/** True when a parsed answer carries data: some top-level field is a non-empty array. */
function hasNonEmptyArray(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).some((field) => Array.isArray(field) && field.length > 0)
  );
}

/**
 * How long an answer stays fresh: a day when the URL's `enddatetime` fell more than
 * {@link GDELT_SETTLE_LAG_MS} before the fetch, 15 minutes otherwise — a `timespan`, no window,
 * or a window ending within the last day or later. A malformed `enddatetime` parses to `NaN`,
 * which compares false and takes the short window.
 */
function freshnessMs(params: URLSearchParams, fetchedAt: number): number {
  const end = params.get('enddatetime') ?? '';
  const endMs = Date.parse(
    `${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}T${end.slice(8, 10)}:${end.slice(10, 12)}:${end.slice(12, 14)}Z`,
  );
  return endMs < fetchedAt - GDELT_SETTLE_LAG_MS ? GDELT_SETTLED_FRESH_MS : GDELT_FRESH_MS;
}

/**
 * How long after its fetch an answer may stand in for a refused, failed, or empty refetch: its
 * retention, and for a `timespan` URL no longer than the timespan itself — an older answer covers
 * none of the window a new call asks for. A timespan this server cannot parse is never served
 * stale.
 */
function staleServableMs(params: URLSearchParams): number {
  const timespan = params.get('timespan');
  if (timespan === null) return GDELT_CACHE_RETENTION_MS;
  const window = resolveTimespan(timespan);
  if (!window) return 0;
  return Math.min(GDELT_CACHE_RETENTION_MS, window.end.getTime() - window.start.getTime());
}

/**
 * One upstream fetch through the shared pacer, with retries and JSON parsing, under `ctx` —
 * whose signal is the shared fetch's own, not any single caller's.
 *
 * Retry outside, pacer inside: each attempt re-queues and is re-paced, and the pacer's
 * cooldown gate is an absolute instant rather than a duration counted from dequeue, so a
 * backoff and the gate overlap in wall-clock instead of summing. Both GDELT rate-limit
 * shapes — the HTTP 429 `failFastOnRateLimit` re-throws and the HTTP-200 notice
 * `parseGdeltJson` classifies — are raised inside the paced task as a `RateLimited`
 * `McpError`, which is what closes the gate for every other queued caller.
 *
 * Two clocks bound the call. `GDELT_REQUEST_TIMEOUT_MS` is one attempt's deadline, clamped to
 * whatever is left of the total budget so an attempt cannot overshoot it; the budget itself is
 * `GDELT_CALL_DEADLINE_MULTIPLIER` times that, threaded through `withRetry`'s `deadlineMs` so
 * the caller gets this server's classified error rather than their own transport timeout.
 *
 * `onSent` runs as each attempt's request goes upstream, past the queue and the request gap.
 */
function fetchFromGdelt(
  url: string,
  ctx: Context,
  operation: string,
  apiLabel: string,
  maxRetries: number | undefined,
  onSent: () => void,
): Promise<FetchedAnswer> {
  const { requestTimeoutMs } = getServerConfig();
  return withRetry(
    ({ signal, remainingMs }) => {
      const enqueuedAt = Date.now();
      return getGdeltPacer()
        .run(
          async (runSignal) => {
            await holdForGdeltRequestGap(runSignal);
            onSent();
            ctx.log.debug(`${apiLabel} API request`, { url });
            let text: string;
            try {
              const response = await fetchWithTimeout(
                url,
                Math.min(requestTimeoutMs, remainingMs),
                ctx,
                { signal: runSignal, expectedStatuses: [429] },
              ).catch(failFastOnRateLimit);
              text = await response.text();
            } finally {
              recordGdeltRequestSettled();
            }
            return { text, value: parseGdeltJson<unknown>(text, apiLabel) };
          },
          { signal, maxWaitMs: GDELT_MAX_QUEUE_WAIT_MS },
        )
        .catch((error: unknown) => declareShedAsRateLimited(error, Date.now() - enqueuedAt));
    },
    {
      operation,
      context: ctx,
      baseDelayMs: 5100,
      ...(maxRetries !== undefined && { maxRetries }),
      signal: ctx.signal,
      deadlineMs: requestTimeoutMs * GDELT_CALL_DEADLINE_MULTIPLIER,
    },
  ).catch((error: unknown) => {
    if (
      !ctx.signal.aborted &&
      error instanceof McpError &&
      gdeltRefusalReason(error) === 'gdelt_rate_limited'
    ) {
      throw new McpError(
        error.code,
        error.message,
        { ...error.data, retryable: true },
        { cause: error },
      );
    }
    return declareTransientAsUnavailable(error, ctx.signal);
  });
}

/**
 * Re-label an upstream failure the retry ladder treated as transient as the declared
 * `gdelt_unavailable` contract entry.
 *
 * Every `ServiceUnavailable` or `Timeout` that {@link defaultIsTransient} accepts lands here
 * after the ladder gives up: an HTML or empty HTTP 200 body, an HTTP 5xx (a 504 arrives as
 * `Timeout`), a network error, a `FetchTimeout` on the last attempt, and the
 * `retry_deadline_exceeded` the total budget raises. They all mean the same thing to a caller —
 * GDELT did not answer with data — so each surfaces the contract's `ServiceUnavailable` code,
 * its `retryable: true`, and its recovery hint, with `status`, `errorSource`, and
 * `retryAttempts` kept in `data` for whoever reads the logs.
 *
 * What the ladder refused to retry stays as it was: `defaultIsTransient` rejects an error
 * carrying `retryable: false` (HTTP 501) and a caller-side `FetchSignalTimeout`. A call whose
 * own signal has aborted is never re-labelled either — a mid-fetch abort arrives as
 * `RequestCancelled`, an abort mid-backoff rethrows the signal's reason, and telling a client
 * to retry a request nobody is waiting for would be worse than saying nothing.
 */
function declareTransientAsUnavailable(error: unknown, signal: AbortSignal): never {
  if (
    signal.aborted ||
    !(error instanceof McpError) ||
    (error.code !== JsonRpcErrorCode.ServiceUnavailable &&
      error.code !== JsonRpcErrorCode.Timeout) ||
    !defaultIsTransient(error)
  ) {
    throw error;
  }
  throw new McpError(
    JsonRpcErrorCode.ServiceUnavailable,
    error.message,
    { ...error.data, ...GDELT_UNAVAILABLE_DATA },
    { cause: error },
  );
}

/**
 * Re-label a pacer shed as the declared `gdelt_rate_limited` contract entry.
 *
 * A shed carries `data.reason: 'pacer_shed'`, which no tool declares — an undeclared reason
 * reaching a caller is a broken contract. `retryable: false` matches the contract entry and
 * keeps {@link withRetry} from replaying a request the queue has no room for.
 *
 * The shed's own `retryAfter` is projected against the queue as it stands at the shed instant.
 * While the single in-flight slot is held, the pacer floors it at the longest queued wait; with
 * the slot free it can still project 0. `waitedMs` is the caller's measured wait; when the
 * projection has nothing to say, the message reports what the request actually endured and the
 * hint falls back to the configured request gap.
 */
function declareShedAsRateLimited(error: unknown, waitedMs: number): never {
  if (!(error instanceof McpError) || error.data?.reason !== 'pacer_shed') throw error;
  const retryAfter = typeof error.data.retryAfter === 'number' ? error.data.retryAfter : 0;
  const retrySeconds =
    retryAfter > 0 ? retryAfter : Math.ceil(getServerConfig().requestDelayMs / 1000);
  const message =
    retryAfter > 0
      ? `GDELT request queue is saturated — no slot opens within ${retryAfter}s.`
      : `GDELT request queue is saturated — no slot opened in the ${Math.ceil(waitedMs / 1000)}s this request waited.`;
  throw new McpError(
    error.code,
    message,
    {
      ...error.data,
      ...GDELT_RATE_LIMIT_DATA,
      recovery: {
        hint:
          `Requests are already queued against GDELT's one-request-per-five-seconds limit. ` +
          `Wait about ${retrySeconds} seconds before retrying.`,
      },
    },
    { cause: error },
  );
}

/**
 * Re-throw GDELT's HTTP-429 as non-retryable so {@link withRetry} fails fast.
 *
 * `fetchWithTimeout` maps a 429 to a transient `RateLimited` McpError, which `withRetry`
 * would otherwise replay up to four times — every replay landing inside GDELT's still-closed
 * rate-limit window, whose cooldown far outlasts the retry budget. Tagging the error
 * `data.retryable: false` opts it out of `withRetry`'s default transient predicate, so the
 * single rejection leaves the retry ladder immediately. gdeltFetch then restores public
 * retryability so the client can back off and retry later. Other failures retry normally.
 */
function failFastOnRateLimit(error: unknown): never {
  if (error instanceof McpError && error.code === JsonRpcErrorCode.RateLimited) {
    throw new McpError(
      error.code,
      error.message,
      { ...error.data, ...GDELT_RATE_LIMIT_DATA },
      { cause: error },
    );
  }
  throw error;
}

/**
 * Number of leading characters scanned for a rejection marker, and the length of
 * the body excerpt echoed in error messages. GDELT's rejection bodies are single
 * short sentences, so a bounded prefix is enough to classify them.
 */
const BODY_EXCERPT_LIMIT = 200;

/**
 * GDELT query-validation rejections, keyed by a distinctive substring of the body.
 *
 * GDELT serves these as **HTTP 200** with `Content-Type: text/html` despite the body
 * being a bare plain-text sentence, so neither `fetchWithTimeout` (which throws only
 * on non-2xx) nor the `<!DOCTYPE`/`<html` prefix check above catches them — they land
 * in `JSON.parse` and would otherwise surface as a server-fault SerializationError for
 * what is really invalid caller input.
 *
 * This list supplies a **tailored** recovery hint per known wording. It is no longer the
 * sole safety net: an unenumerated rejection wording is still caught by
 * `looksLikeGdeltRejection` (positive identification) and classified as invalid_query with
 * a generic hint, so a newly introduced phrasing never silently regresses to
 * SerializationError. A truncated or genuinely broken upstream body — also a non-JSON 200 —
 * fails that positive-ID test and stays on the SerializationError path (settled in #18).
 * Extend this list when a new wording deserves a more specific hint than the generic fallback.
 */
const GDELT_REJECTIONS: ReadonlyArray<{ marker: string; hint: string; api?: string }> = [
  {
    marker: 'hourly dateres not available',
    api: 'GDELT TV',
    hint: 'Use dateres "day" or request a window of seven days or fewer for hourly resolution.',
  },
  {
    marker: 'invalid query start date',
    hint: 'Check the requested date window and timespan syntax. Use dates inside the API archive and a supported relative unit, or supply startDatetime and endDatetime together.',
  },
  {
    marker: 'timespan is too far in the past',
    hint: 'The relative timespan reaches back before the API archive begins. Use a shorter timespan, or supply startDatetime and endDatetime together with dates inside the archive.',
  },
  {
    marker: 'multiple standalone non-negative',
    hint: 'Avoid conflicting positive station/show/network/market selectors. Supply the station in stations or in query rather than both, or group alternative selectors as required by GDELT.',
  },
  {
    marker: 'invalid/unsupported country',
    hint: 'Use a supported two-character FIPS country code or spell the full country name without spaces, such as sourcecountry:unitedarabemirates.',
  },
  {
    marker: 'invalid station',
    hint:
      'GDELT does not recognize one of the requested station IDs. Use gdelt_list_tv_stations ' +
      'to look up valid IDs and their active date ranges, then retry with one of those.',
  },
  {
    marker: 'must contain at least one station',
    hint: 'Select TV coverage with the stations parameter or a station:, network:, or quoted market: selector in query. Use gdelt_list_tv_stations to find valid station IDs, networks and markets.',
  },
  {
    marker: 'too short or too long',
    hint:
      'GDELT rejected a keyword for its length — single characters are too short. Use a longer, ' +
      'more specific keyword, or quote a multi-word phrase such as "bird flu".',
  },
  {
    marker: 'timespan is too short',
    api: 'GDELT DOC',
    hint: 'The GDELT DOC API rejects a timespan under 15 minutes. Use a window of at least 15 minutes, such as "15min".',
  },
  {
    // Measured live: a 20-minute explicit window is rejected, a 30-minute one accepted.
    marker: 'timespan is too short',
    api: 'GDELT TV',
    hint:
      'The GDELT TV API rejects a window shorter than 30 minutes (it answers in whole clock hours). Widen ' +
      'startDatetime/endDatetime, or the timespan, to at least 30 minutes.',
  },
  {
    marker: 'keywords were too short, too long or too common',
    hint: 'Remove or replace the overly short, overly long, or overly common keyword, then retry the original query structure.',
  },
  {
    marker: 'parenthetical clauses had an error',
    hint:
      'A parenthetical clause is malformed. Balance every opening parenthesis with a closing one, ' +
      'e.g. (flu OR pandemic).',
  },
  {
    marker: 'must be surrounded by ()',
    hint: 'Wrap terms joined by OR in parentheses, e.g. (climate OR energy).',
  },
  {
    marker: 'may only appear inside of a ()',
    hint: 'Wrap terms joined by OR in parentheses, e.g. (climate OR energy).',
  },
  {
    marker: 'illegal character',
    hint:
      'A keyword contains a character GDELT reserves. Wrap the term in double quotes to use it ' +
      'literally, e.g. "f-16".',
  },
];

/**
 * Recovery hint for the GDELT rejection matching a non-JSON response body, if any. An entry
 * scoped to one API (`api`) matches only that API's responses — the same wording can carry a
 * different rule on each.
 */
function matchGdeltRejectionHint(text: string, apiLabel: string): string | undefined {
  const head = text.slice(0, BODY_EXCERPT_LIMIT).toLowerCase();
  return GDELT_REJECTIONS.find(
    (rejection) =>
      head.includes(rejection.marker) &&
      (rejection.api === undefined || rejection.api === apiLabel),
  )?.hint;
}

/**
 * Rate-limit notices GDELT occasionally serves as an HTTP-200 plain-text body instead of a
 * 429. These are transient infrastructure signals, not caller error, so they must route to a
 * fail-fast RateLimited rather than the invalid_query path — and be recognized *before*
 * `looksLikeGdeltRejection`, which would otherwise misread a rate-limit sentence as a bad query.
 */
const GDELT_RATE_LIMIT_MARKERS: ReadonlyArray<string> = [
  'rate limit',
  'too many requests',
  'limit requests',
  'one every 5 seconds',
];

/** True when a non-JSON 200 body is a GDELT rate-limit notice rather than a query rejection. */
function matchesRateLimit(text: string): boolean {
  const head = text.slice(0, BODY_EXCERPT_LIMIT).toLowerCase();
  return GDELT_RATE_LIMIT_MARKERS.some((marker) => head.includes(marker));
}

/**
 * Generic recovery hint for an unenumerated GDELT query rejection — a rejection sentence whose
 * exact wording no marker in `GDELT_REJECTIONS` covers. Points at the common query-syntax faults
 * without over-claiming which one fired.
 */
const GENERIC_REJECTION_HINT =
  'GDELT returned a plain-text notice instead of data, which usually signals a rejected ' +
  'query. Check the query syntax: balance parentheses, wrap terms joined by OR in ' +
  'parentheses such as (climate OR energy), and quote multi-word phrases or reserved ' +
  'characters, e.g. "bird flu".';

/**
 * Longest body still read as a rejection when it carries no terminal punctuation. Not every
 * GDELT rejection is a sentence — some are a labelled value (`Invalid Station: telemundo`),
 * and requiring a closing `.`, `?`, or `!` sent those to the SerializationError path.
 */
const UNPUNCTUATED_REJECTION_LIMIT = 120;

/**
 * Positive identification of a GDELT query rejection: a short, non-JSON body that reads like
 * something GDELT wrote about the caller's query — a leading capital, then either terminal
 * punctuation or a single short line. GDELT emits new rejection wordings faster than the marker
 * list tracks them (#25), so an unenumerated one still classifies as invalid_query (caller
 * fault, generic hint) instead of a server-fault SerializationError. A JSON fragment (`{`/`[`
 * prefix, e.g. a truncated payload) or opaque gateway garbage fails this test and stays on the
 * SerializationError path (#18).
 *
 * The unpunctuated branch is deliberately the looser of the two: a capital-initial infrastructure
 * body served on an HTTP 200 would now be attributed to the caller. That shape is not reachable
 * from the paths above it — a gateway fault arrives as a non-2xx, which `fetchWithTimeout`
 * throws before the body is read — and the alternative is a class of genuine caller errors
 * reported as a server fault with no recovery hint.
 */
function looksLikeGdeltRejection(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > BODY_EXCERPT_LIMIT) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  if (!/^[A-Z]/.test(trimmed)) return false;
  if (/[.?!]$/.test(trimmed)) return true;
  return trimmed.length <= UNPUNCTUATED_REJECTION_LIMIT && !trimmed.includes('\n');
}

/**
 * Parse a GDELT response body, classifying the non-JSON bodies GDELT returns for
 * upstream trouble (HTML, empty) and caller-side query rejections (see
 * `GDELT_REJECTIONS`) before falling back to a generic serialization failure. A body
 * excerpt is quoted as raw text; the framework escapes its `Error:` line in content[].
 *
 * Exported for direct testing — production callers reach it through `gdeltFetch`.
 */
export function parseGdeltJson<T>(text: string, apiLabel: string): T {
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    if (matchesRateLimit(text)) {
      // GDELT serves some rate-limit notices as HTML on a 200. Its cooldown outlasts the
      // retry budget, so fail fast rather than replay into a closed window.
      throw rateLimited(
        `${apiLabel} API returned an HTML rate-limit notice.`,
        GDELT_RATE_LIMIT_DATA,
      );
    }
    throw serviceUnavailable(
      `${apiLabel} API returned HTML instead of data and may be temporarily unavailable.`,
    );
  }
  if (text.trim().length === 0) {
    throw serviceUnavailable(
      `${apiLabel} API returned an empty response — endpoint may be temporarily unavailable.`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // A rate-limit notice is transient infra, not caller error — fail fast (no retry) with
    // GDELT's cooldown cue, and keep it out of the invalid_query path below.
    if (matchesRateLimit(text)) {
      throw rateLimited(`${apiLabel} API rate-limited the request.`, GDELT_RATE_LIMIT_DATA);
    }
    // Enumerated wording → tailored hint; otherwise a rejection-sentence shape → generic hint.
    const hint =
      matchGdeltRejectionHint(text, apiLabel) ??
      (looksLikeGdeltRejection(text) ? GENERIC_REJECTION_HINT : undefined);
    if (hint) {
      // ValidationError is outside withRetry's transient set, so this fails fast
      // instead of replaying a query GDELT will reject identically every time.
      throw validationError(
        `${apiLabel} API rejected the query: ${quoteText(text.trim().slice(0, BODY_EXCERPT_LIMIT))}`,
        { reason: 'invalid_query', recovery: { hint } },
      );
    }
    // Truncated JSON, gateway garbage, or any non-sentence body — genuinely unparseable and
    // not the caller's fault; stays on the SerializationError path (settled in #18).
    throw serializationError(
      `${apiLabel} API returned unparseable response: ${quoteText(text.slice(0, BODY_EXCERPT_LIMIT))}`,
    );
  }
}
