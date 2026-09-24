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
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  GDELT_MAX_QUEUE_WAIT_MS,
  getGdeltPacer,
  holdForGdeltRequestGap,
  recordGdeltRequestSettled,
} from './gdelt-pacer.js';

/** Stable public recovery for every GDELT rate-limit response shape. */
const GDELT_RATE_LIMIT_RECOVERY = {
  hint: 'Wait at least 5 seconds before retrying; GDELT accepts at most one request every 5 seconds.',
} as const;

/** Public data shared by HTTP 429 and HTTP-200 rate-limit responses. */
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
const GDELT_UNAVAILABLE_DATA = {
  reason: 'gdelt_unavailable',
  retryable: true,
  recovery: { hint: 'Retry after a short delay; GDELT may be temporarily unavailable.' },
} as const;

/**
 * The whole call's wall-clock budget, as a multiple of `GDELT_REQUEST_TIMEOUT_MS`. Derived
 * rather than configured separately, since the two numbers are only meaningful against each
 * other. At 2× it is the deadline rather than the attempt count that bounds the ladder: two
 * timeout-length attempts fit, and four fast failures still do.
 */
const GDELT_CALL_DEADLINE_MULTIPLIER = 2;

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
  } else if (timespan) {
    params.set('timespan', timespan);
  }
}

/**
 * Resolve a GDELT timespan string (e.g. "1y", "6m", "7d", "24h", "15min") to an
 * absolute `{ start, end }` date range anchored to now.
 * Returns `undefined` when the string cannot be parsed.
 */
export function resolveTimespan(timespan: string): { start: Date; end: Date } | undefined {
  const match = /^(\d+)(min|h|d|m|y)$/i.exec(timespan.trim());
  if (!match) return;
  const n = parseInt(match[1] as string, 10);
  const unit = (match[2] as string).toLowerCase();
  const end = new Date();
  const start = new Date(end);
  switch (unit) {
    case 'min':
      start.setMinutes(start.getMinutes() - n);
      break;
    case 'h':
      start.setHours(start.getHours() - n);
      break;
    case 'd':
      start.setDate(start.getDate() - n);
      break;
    case 'm':
      start.setMonth(start.getMonth() - n);
      break;
    case 'y':
      start.setFullYear(start.getFullYear() - n);
      break;
  }
  return { start, end };
}

/** Format a Date as YYYY-MM-DD for human-readable display. */
export function formatDateShort(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Fetch a GDELT endpoint through the shared pacer, with retries and JSON parsing.
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
 */
export function gdeltFetch<T>(
  baseUrl: string,
  params: URLSearchParams,
  ctx: Context,
  operation: string,
  apiLabel: string,
): Promise<T> {
  const { requestTimeoutMs } = getServerConfig();
  return withRetry(
    ({ signal, remainingMs }) => {
      const enqueuedAt = Date.now();
      return getGdeltPacer()
        .run(
          async (runSignal) => {
            await holdForGdeltRequestGap(runSignal);
            const url = `${baseUrl}?${params.toString()}`;
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
            return parseGdeltJson<T>(text, apiLabel);
          },
          { signal, maxWaitMs: GDELT_MAX_QUEUE_WAIT_MS },
        )
        .catch((error: unknown) => declareShedAsRateLimited(error, Date.now() - enqueuedAt));
    },
    {
      operation,
      context: ctx,
      baseDelayMs: 5100,
      signal: ctx.signal,
      deadlineMs: requestTimeoutMs * GDELT_CALL_DEADLINE_MULTIPLIER,
    },
  ).catch(declareTimeoutAsUnavailable);
}

/**
 * Re-label an exhausted upstream timeout as the declared `gdelt_unavailable` contract entry.
 *
 * Two shapes reach here, both as a `Timeout` no tool declares: a `FetchTimeout` enriched by
 * {@link withRetry} after the last attempt, and the `retry_deadline_exceeded` the total budget
 * raises. Both mean the same thing to a caller — GDELT did not answer — so both surface the
 * contract's `ServiceUnavailable` code, its `retryable: true`, and its recovery hint, with
 * `errorSource` and `retryAttempts` kept in `data` for whoever reads the logs.
 *
 * Keyed on the timeout shape, never on "the call failed": a caller abort arrives as a
 * `RequestCancelled` carrying `errorSource: 'FetchAborted'`, and telling a client to retry a
 * request nobody is waiting for would be worse than saying nothing.
 */
function declareTimeoutAsUnavailable(error: unknown): never {
  if (!(error instanceof McpError) || error.code !== JsonRpcErrorCode.Timeout) throw error;
  const isExhaustedAttempt = error.data?.errorSource === 'FetchTimeout';
  const isDeadlineExpiry = error.data?.reason === 'retry_deadline_exceeded';
  if (!isExhaustedAttempt && !isDeadlineExpiry) throw error;
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
 * The shed's own `retryAfter` is projected against the queue as it stands at the shed instant,
 * which is empty whenever the single in-flight slot rather than the cooldown gate was the real
 * constraint — so a caller that waited out its whole budget is handed a 0. `waitedMs` is that
 * caller's measured wait; when the projection has nothing to say, the message reports what the
 * request actually endured and the hint falls back to the configured request gap.
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
 * single rejection surfaces immediately, carrying GDELT's "retry after 5 seconds" cue for the
 * client to pace its own backoff. Non-rate-limit errors pass through untouched and retry normally.
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
    marker: 'invalid station',
    hint:
      'GDELT does not recognize one of the requested station IDs. Use gdelt_list_tv_stations ' +
      'to look up valid IDs and their active date ranges, then retry with one of those.',
  },
  {
    marker: 'must contain at least one station',
    hint:
      'The GDELT TV API requires at least one station. Supply the stations parameter, or embed a ' +
      'station: selector in the query — use gdelt_list_tv_stations to find valid station IDs.',
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
 * `GDELT_REJECTIONS`) before falling back to a generic serialization failure.
 *
 * Exported for direct testing — production callers reach it through `gdeltFetch`.
 */
export function parseGdeltJson<T>(text: string, apiLabel: string): T {
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    if (matchesRateLimit(text)) {
      // GDELT serves some rate-limit notices as HTML on a 200. Its cooldown outlasts the
      // retry budget, so fail fast rather than replay into a closed window.
      throw rateLimited(
        `${apiLabel} API returned an HTML rate-limit notice. Retry after 5 seconds.`,
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
      throw rateLimited(
        `${apiLabel} API rate-limited the request. Retry after 5 seconds.`,
        GDELT_RATE_LIMIT_DATA,
      );
    }
    // Enumerated wording → tailored hint; otherwise a rejection-sentence shape → generic hint.
    const hint =
      matchGdeltRejectionHint(text, apiLabel) ??
      (looksLikeGdeltRejection(text) ? GENERIC_REJECTION_HINT : undefined);
    if (hint) {
      // ValidationError is outside withRetry's transient set, so this fails fast
      // instead of replaying a query GDELT will reject identically every time.
      throw validationError(
        `${apiLabel} API rejected the query: ${text.trim().slice(0, BODY_EXCERPT_LIMIT)}`,
        { reason: 'invalid_query', recovery: { hint } },
      );
    }
    // Truncated JSON, gateway garbage, or any non-sentence body — genuinely unparseable and
    // not the caller's fault; stays on the SerializationError path (settled in #18).
    throw serializationError(
      `${apiLabel} API returned unparseable response: ${text.slice(0, BODY_EXCERPT_LIMIT)}`,
    );
  }
}
