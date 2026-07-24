/**
 * @fileoverview Shared fetch helper for GDELT API calls. Handles rate-limiting,
 * retries, HTML error detection, and JSON parsing.
 * @module services/gdelt/gdelt-fetch
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContextLike, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getRateLimiter } from './rate-limiter.js';

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

/** Fetch a GDELT endpoint with rate-limiting, retries, and JSON parsing. */
export function gdeltFetch<T>(
  baseUrl: string,
  params: URLSearchParams,
  ctx: Context,
  operation: string,
  apiLabel: string,
): Promise<T> {
  const limiter = getRateLimiter();
  const rctx = ctx as unknown as RequestContextLike;
  return withRetry(
    async () => {
      await limiter.acquire(ctx.signal);
      const url = `${baseUrl}?${params.toString()}`;
      ctx.log.debug(`${apiLabel} API request`, { url });
      const response = await fetchWithTimeout(url, 30_000, rctx, {
        signal: ctx.signal,
        expectedStatuses: [429],
      }).catch(failFastOnRateLimit);
      const text = await response.text();
      return parseGdeltJson<T>(text, apiLabel);
    },
    { operation, context: rctx, baseDelayMs: 5100, signal: ctx.signal },
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
      { ...error.data, retryable: false },
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
const GDELT_REJECTIONS: ReadonlyArray<{ marker: string; hint: string }> = [
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

/** Recovery hint for the GDELT rejection matching a non-JSON response body, if any. */
function matchGdeltRejectionHint(text: string): string | undefined {
  const head = text.slice(0, BODY_EXCERPT_LIMIT).toLowerCase();
  return GDELT_REJECTIONS.find((rejection) => head.includes(rejection.marker))?.hint;
}

/**
 * Rate-limit notices GDELT occasionally serves as an HTTP-200 plain-text body instead of a
 * 429. These are transient infrastructure signals, not caller error, so they must route to a
 * fail-fast ServiceUnavailable rather than the invalid_query path — and be recognized *before*
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
 * Positive identification of a GDELT query-rejection sentence: a short, non-JSON body that reads
 * like an English sentence (leading capital, terminal punctuation). GDELT emits new rejection
 * wordings faster than the marker list tracks them (#25), so an unenumerated sentence still
 * classifies as invalid_query (caller fault, generic hint) instead of a server-fault
 * SerializationError. A JSON fragment (`{`/`[` prefix, e.g. a truncated payload) or opaque
 * gateway garbage fails this test and stays on the SerializationError path (#18).
 */
function looksLikeGdeltRejection(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > BODY_EXCERPT_LIMIT) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  return /^[A-Z][\s\S]*[.?!]$/.test(trimmed);
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
    // GDELT serves HTML on a 200 when rate-limited; its cooldown outlasts the retry
    // budget, so fail fast (retryable: false) rather than replay into a closed window.
    throw serviceUnavailable(
      `${apiLabel} API returned HTML — likely rate-limited or unavailable. Retry after 5 seconds.`,
      { retryable: false },
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
      throw serviceUnavailable(`${apiLabel} API rate-limited the request. Retry after 5 seconds.`, {
        retryable: false,
      });
    }
    // Enumerated wording → tailored hint; otherwise a rejection-sentence shape → generic hint.
    const hint =
      matchGdeltRejectionHint(text) ??
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
